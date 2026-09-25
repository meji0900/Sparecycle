// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleJobPayments} from "../../src/SparecycleJobPayments.sol";

interface ILiveRewards {
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
    function getEpoch(uint64 epochId) external view returns (Epoch memory);
}

/// @notice SparecycleJobPayments against the reward contract deployed on Robinhood Chain mainnet
///         (0x68A0…8Fe9, 22 Nov 2026). Opt-in: FORK_TESTS=1 FORK_RPC_URL=<rpc> forge test --match-path test/fork/JobPaymentsFork.t.sol
contract JobPaymentsForkTest is Test {
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9;
    address internal treasury = makeAddr("treasury");
    address internal customer = makeAddr("customer");

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC_URL", string("robinhood")));
    }

    function test_Fork_ChargeLandsInLivePot() public {
        ILiveRewards r = ILiveRewards(LIVE_REWARDS);
        SparecycleJobPayments pay = new SparecycleJobPayments(LIVE_REWARDS, treasury);
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        pay.deposit{value: 0.01 ether}();

        uint64 id = r.currentEpoch();
        uint256 potBefore = r.getEpoch(id).pot;
        uint256 balBefore = LIVE_REWARDS.balance;

        address[] memory cs = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        cs[0] = customer;
        as_[0] = 0.002 ether;
        vm.prank(r.scheduler()); // the live scheduler key, read from the contract
        pay.charge(id, cs, as_, keccak256("fork"));

        assertEq(r.getEpoch(id).pot - potBefore, 0.0019 ether, "95% credited to the live open epoch");
        assertEq(LIVE_REWARDS.balance - balBefore, 0.0019 ether);
        assertEq(treasury.balance, 0.0001 ether, "5% to the treasury");
        assertEq(pay.balanceOf(customer), 0.008 ether);

        vm.prank(makeAddr("anyone-else"));
        vm.expectRevert(SparecycleJobPayments.NotScheduler.selector);
        pay.charge(id, cs, as_, bytes32(0));
    }
}
