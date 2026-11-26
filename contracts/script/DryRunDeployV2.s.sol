// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// AUDIT REQUIRED BEFORE MAINNET. This script only SIMULATES the V2 deployment; it has no broadcast step at all.

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {SparecycleJobPaymentsV2} from "../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../src/SparecycleHolderPool.sol";
import {MockPonsFeeEscrow} from "../test/mocks/MockPonsFeeEscrow.sol";
import {MockSpare, MockSwapAdapter} from "../test/mocks/V2Mocks.sol";

/// @title DryRunDeployV2
/// @notice Simulates the deployment order of the V2 contracts and checks the wiring. It never calls
///         `vm.startBroadcast`, so there is nothing to broadcast, and it refuses to run under `--broadcast`.
///
///         Order (three CREATEs from one deployer, addresses predicted from its nonce):
///           1. SparecycleBurner   (priceSource = predicted V2)
///           2. SparecycleJobPaymentsV2 (holderPool = predicted pool; checks the burner points at it)
///           3. SparecycleHolderPool (checks V2 points at it)
///         A real deployment must keep this order and must not send any other transaction from the deployer in
///         between, or the predicted addresses are wrong (the constructors then revert, nothing is half-wired).
///
///         Env (all optional; anything unset is replaced by a local stand-in, so it also runs with no RPC):
///           REWARD_CONTRACT    live SparecycleRewards (ADDR.rewards in src/lib/addresses.ts)
///           TREASURY           the treasury Safe (ADDR.treasurySafe)
///           SPARE_TOKEN        SPARE (ADDR.spareToken)
///           SWAP_ADAPTER       an ISpareSwapAdapter: UniswapV4SpareAdapter (src/adapters), not deployed yet
///                              ([PLACEHOLDER]; its constructor values are in docs/uniswap-v4-adapter.md)
///           USE_BURN_FUNCTION  true = SPARE.burn(), false = send to 0x...dEaD (default true; confirm burn() on
///                              SPARE's verified source first)
///           MAX_ETH_PER_BURN   N12 cap in wei ([PLACEHOLDER]: 1% of the pool's quote-side liquidity, read live)
///           SPARE_PAY_CAP_ETH  N13 per-epoch cap in wei (default 0: SPARE payments stay off until the Safe sets it)
///
///         Local:  node contracts/tools/forge.mjs script script/DryRunDeployV2.s.sol:DryRunDeployV2
///         Fork:   REWARD_CONTRACT=0x... TREASURY=0x... SPARE_TOKEN=0x... SWAP_ADAPTER=0x... MAX_ETH_PER_BURN=... \
///                 node contracts/tools/forge.mjs script script/DryRunDeployV2.s.sol:DryRunDeployV2 --fork-url <rpc>
contract DryRunDeployV2 is Script {
    /// @dev Local stand-in values only (never used when the env gives real ones). Not market data.
    uint256 internal constant LOCAL_MAX_ETH_PER_BURN = 1 ether;
    uint256 internal constant LOCAL_PRICE = 1e14;

    struct Deployed {
        address rewards;
        address treasury;
        address spare;
        address adapter;
        SparecycleBurner burner;
        SparecycleJobPaymentsV2 payments;
        SparecycleHolderPool holderPool;
    }

    function run() external returns (Deployed memory d) {
        require(
            !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume),
            "DryRunDeployV2 only simulates: never pass --broadcast"
        );

        d.rewards = vm.envOr("REWARD_CONTRACT", address(0));
        d.treasury = vm.envOr("TREASURY", address(0));
        d.spare = vm.envOr("SPARE_TOKEN", address(0));
        d.adapter = vm.envOr("SWAP_ADAPTER", address(0));
        bool useBurn = vm.envOr("USE_BURN_FUNCTION", true);
        uint256 maxBurn = vm.envOr("MAX_ETH_PER_BURN", uint256(0));
        uint256 spareCap = vm.envOr("SPARE_PAY_CAP_ETH", uint256(0));

        if (d.rewards == address(0)) {
            d.rewards = address(
                new SparecycleRewards(
                    address(this), address(this), address(0), address(new MockPonsFeeEscrow()), 6 hours
                )
            );
            console2.log("REWARD_CONTRACT not set: local SparecycleRewards stand-in");
        }
        if (d.treasury == address(0)) {
            d.treasury = vm.addr(uint256(keccak256("sparecycle local treasury stand-in")));
            console2.log("TREASURY not set: local stand-in address (derived, not a real wallet)");
        }
        if (d.spare == address(0)) {
            d.spare = address(new MockSpare());
            console2.log("SPARE_TOKEN not set: local MockSpare stand-in");
        }
        if (d.adapter == address(0)) {
            d.adapter = address(new MockSwapAdapter(IERC20(d.spare), LOCAL_PRICE));
            console2.log("SWAP_ADAPTER not set: MockSwapAdapter stand-in ([PLACEHOLDER] for the Uniswap v4 adapter)");
        }
        if (maxBurn == 0) {
            maxBurn = LOCAL_MAX_ETH_PER_BURN;
            console2.log("MAX_ETH_PER_BURN not set: local stand-in 1 ether ([PLACEHOLDER])");
        }
        require(d.rewards.code.length > 0, "REWARD_CONTRACT has no code");
        require(d.spare.code.length > 0, "SPARE_TOKEN has no code");
        require(d.adapter.code.length > 0, "SWAP_ADAPTER has no code");
        if (block.chainid == 4663) require(d.treasury.code.length > 0, "mainnet: TREASURY must be the Safe");

        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);

        d.burner = new SparecycleBurner(d.rewards, d.treasury, d.spare, d.adapter, v2At, useBurn, maxBurn);
        d.payments =
            new SparecycleJobPaymentsV2(d.rewards, d.treasury, address(d.burner), poolAt, d.spare, d.adapter, spareCap);
        d.holderPool = new SparecycleHolderPool(d.rewards, address(d.payments), d.treasury);

        require(address(d.payments) == v2At && address(d.holderPool) == poolAt, "address prediction");
        require(address(d.burner.priceSource()) == address(d.payments), "burner -> V2");
        require(
            d.payments.burner() == address(d.burner) && d.payments.holderPool() == address(d.holderPool), "V2 wiring"
        );
        require(address(d.holderPool.payments()) == address(d.payments), "pool -> V2");
        (uint16 t, uint16 b, uint16 h) = d.payments.currentSplit();
        require(uint256(t) + b + h == 500, "split sums to 500 bps");

        console2.log("SIMULATION ONLY - nothing was broadcast. AUDIT REQUIRED BEFORE MAINNET.");
        console2.log("SparecycleBurner        ", address(d.burner));
        console2.log("SparecycleJobPaymentsV2 ", address(d.payments));
        console2.log("SparecycleHolderPool    ", address(d.holderPool));
        console2.log("split treasury/burner/holder bps (N1)", t, b, h);
        console2.log("SPARE discount bps (N2) ", d.payments.SPARE_DISCOUNT_BPS());
        console2.log("max price deviation bps (N13)", d.payments.maxPriceDeviationBps());
        console2.log("SPARE pay cap wei (N13) ", spareCap);
        console2.log("max ETH per burn wei (N12)", maxBurn);
        console2.log("burn slippage bps (N12) ", d.burner.maxSlippageBps());
        console2.log("rollover epochs (N19)   ", d.holderPool.UNCLAIMED_ROLLOVER_EPOCHS());
    }
}
