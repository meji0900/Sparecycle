// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4Minimal.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";
import {MockSpare} from "../mocks/V2Mocks.sol";

contract EthRecorder {
    address public lastSender;
    uint256 public received;

    receive() external payable {
        lastSender = msg.sender;
        received += msg.value;
    }
}

contract EthRejecter {
    receive() external payable {
        revert("no eth");
    }
}

/// @notice Receives the ETH of a sale and tries to re-enter the adapter from there.
contract Reenterer {
    Adapter public immutable adapter;
    bytes public err;
    uint256 public received;

    constructor(Adapter a) {
        adapter = a;
    }

    receive() external payable {
        try adapter.buySpare{value: msg.value}(0, address(this)) {}
        catch (bytes memory e) {
            err = e;
        }
        received += msg.value;
    }
}

/// @notice UniswapV4SpareAdapter against MockPoolManager (v4-style flash accounting). Test values only: a fixed rate
///         and a 290 bps output fee like the Pons hook on the live pool. The live pool is in test/fork/V4AdapterFork.
contract UniswapV4SpareAdapterTest is Test {
    // The live key's values (verified on-chain: docs/uniswap-v4-adapter.md). Used for the pool-id check only.
    address internal constant LIVE_SPARE = 0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A;
    address internal constant LIVE_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    bytes32 internal constant LIVE_POOL_ID = 0x6c779d26cc59abb9f22d348257ee013b66d2a5f0d9dcf1bb9fa9338874eab1bd;

    uint160 internal constant SQRT_P = 79228162514264337593543950336 * 5000; // 25e6 SPARE per ETH
    uint256 internal constant RATE = 25_000_000; // SPARE base units per wei
    uint256 internal constant FEE_BPS = 290;

    MockPoolManager internal pm;
    MockSpare internal spare;
    Adapter internal adapter;
    address internal hook;
    address internal user = makeAddr("user");
    EthRecorder internal rec;

    function setUp() public {
        pm = new MockPoolManager();
        spare = new MockSpare();
        hook = address(new EthRecorder()); // any contract: the mock does not call hooks
        pm.setPool(_key(), SQRT_P);
        pm.setRate(RATE);
        pm.setOutFeeBps(FEE_BPS);
        spare.mint(address(pm), 1e30);
        vm.deal(address(pm), 1_000 ether);
        adapter = new Adapter(address(pm), address(spare), 0, 200, hook);
        rec = new EthRecorder();
        vm.deal(user, 100 ether);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: address(spare), fee: 0, tickSpacing: 200, hooks: hook});
    }

    function _buyOut(uint256 ethIn) internal pure returns (uint256 o) {
        o = ethIn * RATE;
        o -= (o * FEE_BPS) / 10_000;
    }

    function _sellOut(uint256 spareIn) internal pure returns (uint256 o) {
        o = spareIn / RATE;
        o -= (o * FEE_BPS) / 10_000;
    }

    function _assertEmpty() internal view {
        assertEq(address(adapter).balance, 0, "adapter keeps no ETH");
        assertEq(spare.balanceOf(address(adapter)), 0, "adapter keeps no SPARE");
        assertEq(pm.deltaOf(address(0)), 0);
        assertEq(pm.deltaOf(address(spare)), 0);
        assertFalse(pm.unlocked());
    }

    // ================================================================ construction

    function test_Constructor_KeyAndId() public view {
        PoolKey memory k = adapter.poolKey();
        assertEq(k.currency0, address(0), "native ETH is currency0");
        assertEq(k.currency1, address(spare));
        assertEq(k.fee, 0);
        assertEq(k.tickSpacing, 200);
        assertEq(k.hooks, hook);
        assertEq(adapter.poolId(), keccak256(abi.encode(k)));
        assertEq(address(adapter.poolManager()), address(pm));
        assertEq(address(adapter.spare()), address(spare));
        assertEq(adapter.spotSqrtPriceX96(), SQRT_P);
    }

    /// @notice The live PoolKey hashes to the pool id read from the PoolManager's Initialize event (and DexScreener).
    function test_LivePoolKeyHashesToLivePoolId() public pure {
        PoolKey memory k =
            PoolKey({currency0: address(0), currency1: LIVE_SPARE, fee: 0, tickSpacing: 200, hooks: LIVE_HOOK});
        assertEq(keccak256(abi.encode(k)), LIVE_POOL_ID);
        // The hook address encodes its permissions (v4 Hooks): beforeInitialize | afterSwap | afterSwapReturnDelta.
        assertEq(uint160(LIVE_HOOK) & 0x3fff, (1 << 13) | (1 << 6) | (1 << 2));
    }

    function test_Constructor_Rejects() public {
        vm.expectRevert(Adapter.ZeroAddress.selector);
        new Adapter(address(0), address(spare), 0, 200, hook);
        vm.expectRevert(Adapter.ZeroAddress.selector);
        new Adapter(address(pm), address(0), 0, 200, hook);
        vm.expectRevert(abi.encodeWithSelector(Adapter.NoCode.selector, user));
        new Adapter(user, address(spare), 0, 200, hook);
        vm.expectRevert(abi.encodeWithSelector(Adapter.NoCode.selector, user));
        new Adapter(address(pm), user, 0, 200, hook);
        vm.expectRevert(abi.encodeWithSelector(Adapter.NoCode.selector, user));
        new Adapter(address(pm), address(spare), 0, 200, user);
        // a key that is not an initialized pool (another tick spacing)
        bytes32 id = keccak256(abi.encode(address(0), address(spare), uint24(0), int24(60), hook));
        vm.expectRevert(abi.encodeWithSelector(Adapter.PoolNotInitialized.selector, id));
        new Adapter(address(pm), address(spare), 0, 60, hook);
    }

    // ================================================================ buySpare

    function test_Buy_DeliversToRecipient() public {
        vm.prank(user);
        uint256 out = adapter.buySpare{value: 0.01 ether}(1, address(rec));
        assertEq(out, _buyOut(0.01 ether));
        assertEq(spare.balanceOf(address(rec)), out, "SPARE straight to `to`");
        assertEq(user.balance, 100 ether - 0.01 ether, "all of msg.value spent");
        assertEq(pm.swaps(), 1);
        (bool zeroForOne, int256 amountSpecified, uint160 limit) = pm.lastParams();
        assertTrue(zeroForOne, "ETH -> SPARE");
        assertEq(amountSpecified, -int256(0.01 ether), "exact input");
        assertEq(limit, 4295128739 + 1, "no price limit");
        _assertEmpty();
    }

    function test_Buy_MinOut() public {
        uint256 expected = _buyOut(0.01 ether);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Adapter.InsufficientOutput.selector, expected, expected + 1));
        adapter.buySpare{value: 0.01 ether}(expected + 1, user);
        vm.prank(user);
        assertEq(adapter.buySpare{value: 0.01 ether}(expected, user), expected, "exactly the minimum passes");
        _assertEmpty();
    }

    function test_Buy_Rejects() public {
        vm.startPrank(user);
        vm.expectRevert(Adapter.ZeroAmount.selector);
        adapter.buySpare{value: 0}(0, user);
        vm.expectRevert(abi.encodeWithSelector(Adapter.BadRecipient.selector, address(0)));
        adapter.buySpare{value: 1}(0, address(0));
        vm.expectRevert(abi.encodeWithSelector(Adapter.BadRecipient.selector, address(adapter)));
        adapter.buySpare{value: 1}(0, address(adapter));
        vm.expectRevert(abi.encodeWithSelector(Adapter.BadRecipient.selector, address(pm)));
        adapter.buySpare{value: 1}(0, address(pm));
        vm.stopPrank();
    }

    function test_Buy_PartialFillReverts() public {
        pm.setShortFill(1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Adapter.PartialFill.selector, 0.01 ether, 0.01 ether - 1));
        adapter.buySpare{value: 0.01 ether}(0, user);
    }

    function test_Buy_ZeroOutputReverts() public {
        pm.setZeroOut(true);
        vm.prank(user);
        vm.expectRevert(Adapter.NoOutput.selector);
        adapter.buySpare{value: 0.01 ether}(0, user);
    }

    // ================================================================ sellSpare

    function _giveSpare(address who, uint256 amount) internal {
        spare.mint(who, amount);
        vm.prank(who);
        spare.approve(address(adapter), amount);
    }

    function test_Sell_PaysFromAdapter() public {
        uint256 amount = 1_000_000e18;
        _giveSpare(user, amount);
        uint256 pmSpare = spare.balanceOf(address(pm));
        vm.prank(user);
        uint256 out = adapter.sellSpare(amount, 1, payable(address(rec)));
        assertEq(out, _sellOut(amount));
        assertEq(rec.received(), out);
        assertEq(rec.lastSender(), address(adapter), "ETH comes from the adapter, not the PoolManager");
        assertEq(spare.balanceOf(user), 0, "exactly spareIn pulled");
        assertEq(spare.balanceOf(address(pm)), pmSpare + amount, "pulled straight into the PoolManager");
        assertEq(spare.allowance(user, address(adapter)), 0);
        (bool zeroForOne, int256 amountSpecified, uint160 limit) = pm.lastParams();
        assertFalse(zeroForOne, "SPARE -> ETH");
        assertEq(amountSpecified, -int256(amount));
        assertEq(limit, 1461446703485210103287273052203988822378723970342 - 1);
        _assertEmpty();
    }

    function test_Sell_MinOut() public {
        uint256 amount = 1_000_000e18;
        _giveSpare(user, amount);
        uint256 expected = _sellOut(amount);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Adapter.InsufficientOutput.selector, expected, expected + 1));
        adapter.sellSpare(amount, expected + 1, payable(user));
        vm.prank(user);
        assertEq(adapter.sellSpare(amount, expected, payable(user)), expected);
        _assertEmpty();
    }

    function test_Sell_NeedsAllowance() public {
        spare.mint(user, 1e18);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(adapter), 0, 1e18)
        );
        adapter.sellSpare(1e18, 0, payable(user));
        vm.prank(user);
        spare.approve(address(adapter), 1e18 - 1);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(adapter), 1e18 - 1, 1e18)
        );
        adapter.sellSpare(1e18, 0, payable(user));
        assertEq(spare.balanceOf(user), 1e18, "nothing moved");
    }

    function test_Sell_Rejects() public {
        vm.startPrank(user);
        vm.expectRevert(Adapter.ZeroAmount.selector);
        adapter.sellSpare(0, 0, payable(user));
        vm.expectRevert(abi.encodeWithSelector(Adapter.AmountTooLarge.selector, uint256(1) << 127));
        adapter.sellSpare(uint256(1) << 127, 0, payable(user));
        vm.expectRevert(abi.encodeWithSelector(Adapter.BadRecipient.selector, address(0)));
        adapter.sellSpare(1, 0, payable(address(0)));
        vm.stopPrank();
    }

    function test_Sell_PartialFillReverts() public {
        _giveSpare(user, 1e24);
        pm.setShortFill(5);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Adapter.PartialFill.selector, 1e24, 1e24 - 5));
        adapter.sellSpare(1e24, 0, payable(user));
    }

    function test_Sell_RecipientRefusesEth() public {
        _giveSpare(user, 1e24);
        EthRejecter r = new EthRejecter();
        vm.prank(user);
        vm.expectRevert(Adapter.EthTransferFailed.selector);
        adapter.sellSpare(1e24, 0, payable(address(r)));
    }

    function test_Sell_ReentryFromRecipientBlocked() public {
        Reenterer r = new Reenterer(adapter);
        _giveSpare(user, 1e24);
        vm.prank(user);
        uint256 out = adapter.sellSpare(1e24, 0, payable(address(r)));
        assertEq(r.received(), out);
        assertEq(bytes4(r.err()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, "re-entry refused");
        _assertEmpty();
    }

    // ================================================================ callback and ETH

    function test_UnlockCallback_OnlyPoolManager() public {
        vm.expectRevert(Adapter.NotPoolManager.selector);
        adapter.unlockCallback(abi.encode(true, uint256(1), user, address(0)));
        // a sale "for" someone with an allowance cannot be started by a third party through the callback
        _giveSpare(user, 1e24);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Adapter.NotPoolManager.selector);
        adapter.unlockCallback(abi.encode(false, uint256(1e24), address(0), user));
        assertEq(spare.balanceOf(user), 1e24);
    }

    function test_Receive_OnlyFromPoolManagerDuringASwap() public {
        vm.prank(user);
        (bool ok,) = address(adapter).call{value: 1}("");
        assertFalse(ok, "random ETH refused");
        vm.prank(address(pm));
        (ok,) = address(adapter).call{value: 1}("");
        assertFalse(ok, "PoolManager ETH outside a swap refused");
    }

    // ================================================================ fuzz

    function testFuzz_BuyThenSell_KeepsNothing(uint96 ethIn, uint96 extraSpare) public {
        ethIn = uint96(bound(ethIn, 1, 50 ether));
        vm.deal(user, ethIn);
        vm.prank(user);
        uint256 out = adapter.buySpare{value: ethIn}(_buyOut(ethIn), user);
        assertEq(out, _buyOut(ethIn));
        _assertEmpty();

        uint256 sellAmt = bound(uint256(extraSpare), RATE * 100, out + RATE * 100);
        _giveSpare(user, sellAmt > out ? sellAmt - out : 0);
        vm.prank(user);
        spare.approve(address(adapter), sellAmt);
        uint256 balBefore = user.balance;
        vm.prank(user);
        uint256 ethOut = adapter.sellSpare(sellAmt, _sellOut(sellAmt), payable(user));
        assertEq(ethOut, _sellOut(sellAmt));
        assertEq(user.balance, balBefore + ethOut);
        _assertEmpty();
    }
}
