// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {
    V4ForkBase,
    IV4QuoterFork,
    IStateViewFork,
    IPonsMemeHookFork,
    IUniversalRouterFork,
    PonsLaunchInfo,
    ExactInputSingleParams
} from "./V4ForkBase.sol";

/// @notice UniswapV4SpareAdapter against the live SPARE/ETH pool, on a local fork (nothing is broadcast). Opt-in:
///           FORK_TESTS=1 [FORK_RPC_URL=<rpc>] [FORK_BLOCK=<n>] node contracts/tools/forge.mjs test \
///             --match-path "test/fork/*V4*" -vv
///         Skips cleanly when FORK_TESTS is not 1 or the RPC cannot be reached. Prints the measured cost of each
///         swap (hook cut + price impact) in hundredths of a bp ("cbps": 29000 = 2.90%).
contract V4AdapterForkTest is V4ForkBase {
    address internal buyer = makeAddr("v4-fork-buyer");

    function setUp() public {
        if (!_forkOrSkip()) return;
        _deployAdapter();
        vm.deal(buyer, 10 ether);
    }

    // ================================================================ the on-chain facts

    /// @notice What docs/uniswap-v4-adapter.md records, re-read from the fork.
    function test_Fork_VerifiedFacts() public view {
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager code");
        assertEq(IStateViewFork(STATE_VIEW).poolManager(), POOL_MANAGER, "StateView -> PoolManager");
        assertEq(IV4QuoterFork(V4_QUOTER).poolManager(), POOL_MANAGER, "V4Quoter -> PoolManager");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "Universal Router code");
        assertEq(IPonsMemeHookFork(HOOK).poolManager(), POOL_MANAGER, "hook -> PoolManager");

        assertEq(keccak256(abi.encode(_key())), POOL_ID, "the key hashes to the pool id");
        assertEq(adapter.poolId(), POOL_ID);
        (uint160 s,, uint24 protocolFee, uint24 lpFee) = IStateViewFork(STATE_VIEW).getSlot0(POOL_ID);
        assertGt(s, 0, "initialized");
        assertEq(adapter.spotSqrtPriceX96(), s, "the adapter reads the same slot0 as StateView");
        assertEq(lpFee, 0, "LP fee 0: the hook takes the fee");
        assertEq(protocolFee, 0, "no v4 protocol fee today");

        PonsLaunchInfo memory l = IPonsMemeHookFork(HOOK).launches(POOL_ID);
        assertTrue(l.registered);
        assertFalse(l.memecoinIsCurrency0);
        assertEq(l.memecoin, SPARE);
        assertEq(l.quoteToken, address(0), "quoted in native ETH");
        assertEq(l.hookFeeBps, 100, "hook fee, frozen at registration");
        assertEq(l.creatorTaxBps, 190, "creator tax, frozen at registration");
        assertEq(uint256(l.hookFeeBps) + l.creatorTaxBps, HOOK_CUT_BPS);
        assertEq(l.creator, 0xBA839DD7d615bD5100236f7bbAbB50EC920cC728, "creator = ADDR.teamWallet");
        console2.log("spot price, wei per 1e18 SPARE:", _spotPrice());
        console2.log("ETH side of the pool (wei):", _ethReserve());
    }

    // ================================================================ buys and sells

    function _buy(uint256 ethIn) internal returns (uint256 out) {
        uint256 spot = _spotSpareFor(ethIn);
        (uint256 quoted,) = IV4QuoterFork(V4_QUOTER)
            .quoteExactInputSingle(IV4QuoterFork.QuoteExactSingleParams(_key(), true, uint128(ethIn), ""));
        uint256 before = spare.balanceOf(buyer);
        vm.prank(buyer);
        out = adapter.buySpare{value: ethIn}(quoted, buyer);
        assertEq(out, quoted, "the adapter delivers exactly Uniswap's V4Quoter quote");
        assertEq(spare.balanceOf(buyer) - before, out);
        uint256 total = _costCbps(out, spot);
        uint256 noHook = _costCbps(out, spot - (spot * HOOK_CUT_BPS) / 10_000);
        console2.log("buy ETH in (wei):", ethIn);
        console2.log("  SPARE out:", out);
        console2.log("  total cost vs spot (cbps):", total);
        console2.log("  price impact without the 290 bps hook cut (cbps):", noHook);
        assertGe(total, HOOK_CUT_BPS * 100, "at least the hook cut");
        _assertAdapterEmpty();
    }

    function _sell(uint256 spareIn) internal returns (uint256 ethOut) {
        uint256 spot = _spotEthFor(spareIn);
        (uint256 quoted,) = IV4QuoterFork(V4_QUOTER)
            .quoteExactInputSingle(IV4QuoterFork.QuoteExactSingleParams(_key(), false, uint128(spareIn), ""));
        vm.prank(buyer);
        spare.approve(address(adapter), spareIn);
        uint256 spareBefore = spare.balanceOf(buyer);
        uint256 ethBefore = buyer.balance;
        vm.prank(buyer);
        ethOut = adapter.sellSpare(spareIn, quoted, payable(buyer));
        assertEq(ethOut, quoted, "the adapter delivers exactly Uniswap's V4Quoter quote");
        assertEq(buyer.balance - ethBefore, ethOut);
        assertEq(spareBefore - spare.balanceOf(buyer), spareIn, "exactly spareIn pulled");
        assertEq(spare.allowance(buyer, address(adapter)), 0, "allowance used up");
        console2.log("sell SPARE in:", spareIn);
        console2.log("  ETH out (wei):", ethOut);
        console2.log("  total cost vs spot (cbps):", _costCbps(ethOut, spot));
        console2.log(
            "  price impact without the 290 bps hook cut (cbps):",
            _costCbps(ethOut, spot - (spot * HOOK_CUT_BPS) / 10_000)
        );
        _assertAdapterEmpty();
    }

    function test_Fork_Buy0_001EthAndSellBack() public {
        uint256 out = _buy(0.001 ether);
        uint256 back = _sell(out);
        console2.log("round trip 0.001 ETH -> SPARE -> ETH, cost (cbps):", _costCbps(back, 0.001 ether));
        assertLt(back, 0.001 ether, "a round trip pays the hook twice");
    }

    function test_Fork_Buy0_01EthAndSellBack() public {
        uint256 out = _buy(0.01 ether);
        uint256 back = _sell(out);
        console2.log("round trip 0.01 ETH -> SPARE -> ETH, cost (cbps):", _costCbps(back, 0.01 ether));
        assertLt(back, 0.01 ether);
    }

    /// @notice Sells of SPARE worth 0.001 and 0.01 ETH at the spot price (the size of a SPARE-paid charge's sale).
    function test_Fork_SellWorth0_001And0_01Eth() public {
        uint256 small = _spotSpareFor(0.001 ether);
        uint256 large = _spotSpareFor(0.01 ether);
        deal(SPARE, buyer, small + large);
        uint256 snap = vm.snapshotState();
        _sell(small);
        vm.revertToState(snap);
        _sell(large);
    }

    // ================================================================ minimum output

    function test_Fork_BuyMinOutReverts() public {
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        uint256 out = adapter.buySpare{value: 0.01 ether}(0, buyer);
        vm.revertToState(snap);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Adapter.InsufficientOutput.selector, out, out + 1));
        adapter.buySpare{value: 0.01 ether}(out + 1, buyer);
        vm.prank(buyer);
        assertEq(adapter.buySpare{value: 0.01 ether}(out, buyer), out, "exactly the minimum passes");
        _assertAdapterEmpty();
    }

    function test_Fork_SellMinOutReverts() public {
        uint256 amount = _spotSpareFor(0.01 ether);
        deal(SPARE, buyer, amount);
        vm.prank(buyer);
        spare.approve(address(adapter), amount);
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        uint256 out = adapter.sellSpare(amount, 0, payable(buyer));
        vm.revertToState(snap);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Adapter.InsufficientOutput.selector, out, out + 1));
        adapter.sellSpare(amount, out + 1, payable(buyer));
        assertEq(spare.balanceOf(buyer), amount, "nothing moved on the revert");
        vm.prank(buyer);
        assertEq(adapter.sellSpare(amount, out, payable(buyer)), out);
        _assertAdapterEmpty();
    }

    /// @notice A sale of the whole ETH side is impossible: a big SPARE dump only gets close to it, and the adapter
    ///         still holds nothing afterwards.
    function test_Fork_LargeSellNeverEmptiesThePool() public {
        uint256 reserve = _ethReserve();
        uint256 amount = _spotSpareFor(reserve) * 5;
        deal(SPARE, buyer, amount);
        vm.prank(buyer);
        spare.approve(address(adapter), amount);
        vm.prank(buyer);
        uint256 out = adapter.sellSpare(amount, 1, payable(buyer));
        assertLt(out, reserve, "constant product: never the whole side");
        console2.log("dump of 5x the ETH side's worth: ETH out (wei)", out, "of", reserve);
        _assertAdapterEmpty();
    }

    // ================================================================ the Universal Router layout (phase 2a)

    /// @notice Both Universal Routers Uniswap lists for chain 4663 (v4-periphery with minHopPriceX36) run the exact
    ///         V4_SWAP payload that src/server/burns.ts encodeBurnSwap builds: SWAP_EXACT_IN_SINGLE + SETTLE_ALL +
    ///         TAKE(SPARE, dead, 0 = the whole open delta), paid with the call value.
    function test_Fork_UniversalRouterBurnPayloadLayout() public {
        uint256 snap = vm.snapshotState();
        _routerBurn(UNIVERSAL_ROUTER);
        vm.revertToState(snap);
        _routerBurn(UNIVERSAL_ROUTER_PREVIOUS);
    }

    function _routerBurn(address router) internal {
        address dead = 0x000000000000000000000000000000000000dEaD;
        uint256 amountIn = 0.001 ether;
        (uint256 quoted,) = IV4QuoterFork(V4_QUOTER)
            .quoteExactInputSingle(IV4QuoterFork.QuoteExactSingleParams(_key(), true, uint128(amountIn), ""));
        bytes memory actions = abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0e));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(_key(), true, uint128(amountIn), uint128(quoted), 0, ""));
        params[1] = abi.encode(address(0), amountIn);
        params[2] = abi.encode(SPARE, dead, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        uint256 deadBefore = spare.balanceOf(dead);
        uint256 routerEth = router.balance;
        vm.prank(buyer);
        IUniversalRouterFork(router).execute{value: amountIn}(hex"10", inputs, block.timestamp + 60);
        assertEq(spare.balanceOf(dead) - deadBefore, quoted, "SPARE to the dead address, as quoted");
        assertEq(router.balance, routerEth, "router keeps no ETH");
    }
}
