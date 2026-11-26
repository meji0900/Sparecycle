// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {SpareBurn} from "../../src/libraries/SpareBurn.sol";
import {MockSwapAdapter} from "../mocks/V2Mocks.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

interface ILiveRewardsV2 {
    struct Epoch {
        uint64 index;
        uint64 startedAt;
        uint64 endedAt;
        uint256 pot;
        uint256 reserved;
        uint256 claimed;
        bytes32 merkleRoot;
        bool settled;
    }

    function currentEpoch() external view returns (uint64);
    function scheduler() external view returns (address);
    function epochLength() external view returns (uint64);
    function getEpoch(uint64 epochId) external view returns (Epoch memory);
    function closeEpochAndPostRoot(uint64 epochId, bytes32 merkleRoot, uint256 reserved) external;
}

/// @notice Burns through SpareBurn from a plain contract (to test the real SPARE's burn()).
contract SpareBurnProbe {
    function burnIt(IERC20 token, uint256 amount) external {
        SpareBurn.burn(token, amount, true);
    }
}

/// @notice V2 against the live chain, simulated locally (nothing is broadcast). Opt-in:
///           FORK_TESTS=1 [FORK_RPC_URL=<rpc>] node contracts/tools/forge.mjs test --match-path test/fork/V2Fork.t.sol -vv
///         FORK_RPC_URL defaults to the site's read-only relay (the Robinhood public RPC is DNS-blocked on some ISPs).
///         Skips cleanly when the RPC cannot be reached. Addresses are ADDR.rewards / ADDR.spareToken /
///         ADDR.treasurySafe from src/lib/addresses.ts. No swap against the real pool is made here: there is no
///         Uniswap v4 adapter yet, so the "moved pool price" acceptance test runs on the mock adapter only.
contract V2ForkTest is Test {
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9; // ADDR.rewards
    address internal constant SPARE = 0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A; // ADDR.spareToken
    address internal constant TREASURY_SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B; // ADDR.treasurySafe

    bool internal forked;

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true, "set FORK_TESTS=1 to run");
            return;
        }
        string memory url = vm.envOr("FORK_RPC_URL", string("https://sparecycle.tech/api/rpc"));
        try vm.createSelectFork(url) {
            forked = true;
        } catch {
            vm.skip(true, "fork RPC unreachable");
            return;
        }
        // A fork needs eth_getStorageAt; read-only relays may refuse it (the sparecycle.tech relay does).
        try this.probeStorage() {}
        catch {
            vm.skip(true, "fork RPC refuses storage reads (eth_getStorageAt): use FORK_RPC_URL=<full RPC>");
        }
    }

    /// @dev External so setUp can catch a failed remote storage read.
    function probeStorage() external view returns (bytes32) {
        return vm.load(LIVE_REWARDS, bytes32(uint256(2)));
    }

    /// @notice The brief reads `burn(uint256)` in SPARE's bytecode; this checks it really burns (supply drops).
    function test_Fork_SpareBurnFunctionBurns() public {
        SpareBurnProbe probe = new SpareBurnProbe();
        deal(SPARE, address(probe), 1 ether, true);
        uint256 supply = IERC20(SPARE).totalSupply();
        probe.burnIt(IERC20(SPARE), 1 ether);
        assertEq(supply - IERC20(SPARE).totalSupply(), 1 ether, "SPARE.burn reduces the total supply");
        assertEq(IERC20(SPARE).balanceOf(address(probe)), 0);
    }

    ILiveRewardsV2 internal r = ILiveRewardsV2(LIVE_REWARDS);
    SparecycleBurner internal burner;
    SparecycleJobPaymentsV2 internal pay;
    SparecycleHolderPool internal pool;
    address internal customer = makeAddr("fork-customer");

    function _deploy() internal {
        MockSwapAdapter adapter = new MockSwapAdapter(IERC20(SPARE), 1); // unused here: no swaps on the fork
        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        burner = new SparecycleBurner(LIVE_REWARDS, TREASURY_SAFE, SPARE, address(adapter), v2At, true, 1 ether);
        pay = new SparecycleJobPaymentsV2(
            LIVE_REWARDS, TREASURY_SAFE, address(burner), poolAt, SPARE, address(adapter), 0
        );
        pool = new SparecycleHolderPool(LIVE_REWARDS, address(pay), TREASURY_SAFE);
    }

    function _chargeOne(uint64 epochId, uint256 amount, bytes32 listHash) internal {
        address[] memory cs = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        cs[0] = customer;
        as_[0] = amount;
        vm.prank(r.scheduler());
        pay.charge(epochId, cs, as_, listHash);
    }

    /// @notice A V2 charge against the live reward contract: 95% into the live open pot, the 5% split; then a
    ///         holder-pool credit claim, and the credits pay for a job.
    function test_Fork_ChargeSplitAndCreditClaim() public {
        _deploy();
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        pay.deposit{value: 0.01 ether}();

        uint64 id = r.currentEpoch();
        uint256 potBefore = r.getEpoch(id).pot;
        uint256 safeBefore = TREASURY_SAFE.balance;
        _chargeOne(id, 0.01 ether, keccak256("fork-v2"));
        assertEq(r.getEpoch(id).pot - potBefore, 0.0095 ether, "95% into the live open pot");
        assertEq(TREASURY_SAFE.balance - safeBefore, 0.0002 ether, "200 bps to the Safe");
        assertEq(address(burner).balance, 0.00015 ether);
        assertEq(address(pool).balance, 0.00015 ether);

        // close the live epoch in the simulation (empty root) so a holder root can be posted for it
        vm.warp(uint256(r.getEpoch(id).startedAt) + r.epochLength());
        vm.prank(r.scheduler());
        r.closeEpochAndPostRoot(id, bytes32(0), 0);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = pool.leafOf(id, customer, 1, 0.0001 ether);
        leaves[1] = pool.leafOf(id, makeAddr("fork-holder-2"), 1, 0.00005 ether);
        vm.prank(r.scheduler());
        pool.postRoot(id, MerkleHelper.root(leaves), 0.00015 ether);
        bytes32[] memory proof = MerkleHelper.proof(leaves, leaves[0]);
        vm.prank(customer);
        pool.claim(id, 1, 0.0001 ether, proof);
        assertEq(pay.creditOf(customer), 0.0001 ether);

        _chargeOne(r.currentEpoch(), 0.0001 ether, keccak256("fork-v2-credits"));
        assertEq(pay.creditOf(customer), 0, "credits paid for the job");
    }
}
