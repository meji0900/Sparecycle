// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UniswapV4SpareAdapter} from "../src/adapters/UniswapV4SpareAdapter.sol";
import {SparecycleBurner} from "../src/SparecycleBurner.sol";
import {SparecycleJobPaymentsV2} from "../src/SparecycleJobPaymentsV2.sol";
import {SparecycleHolderPool} from "../src/SparecycleHolderPool.sol";

interface IRewardsView {
    function owner() external view returns (address);
    function scheduler() external view returns (address);
    function payoutToken() external view returns (address);
    function currentEpoch() external view returns (uint64);
}

/// @title DeployV2
/// @notice INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. Deploys the V2 payment stack next to the live
///         SparecycleRewards, in one run from one deployer (the signer comes from the forge CLI, `--account
///         <keystore>`; no key is read here). Without `--broadcast` forge only simulates.
///
///         Order (four CREATEs, nothing else sent from the deployer in between; addresses predicted from its nonce):
///           1. UniswapV4SpareAdapter  (the live SPARE/ETH v4 pool; reverts if that pool is not initialized)
///           2. SparecycleBurner       (priceSource = the predicted V2)
///           3. SparecycleJobPaymentsV2 (holderPool = the predicted pool; checks the burner points back at it)
///           4. SparecycleHolderPool   (checks V2 points at it)
///         If a prediction is wrong a constructor reverts, so nothing is left half-wired.
///
///         Env (no address or amount has a guessed default):
///           REWARD_CONTRACT      the live SparecycleRewards (ADDR.rewards)                                required
///           TREASURY             the treasury Safe (owner of every setting; receives the treasury share)  required
///           SPARE_TOKEN          SPARE (ADDR.spareToken)                                                  required
///           SPARE_HAS_BURN       true = SPARE.burn(), false = send to 0x...dEaD                           required
///           V4_POOL_MANAGER      Uniswap v4 PoolManager                                                   required
///           V4_POOL_FEE          the SPARE/ETH pool key's fee                                             required
///           V4_TICK_SPACING      the SPARE/ETH pool key's tick spacing                                    required
///           V4_HOOKS             the SPARE/ETH pool key's hooks (the Pons hook)                           required
///           MAX_ETH_PER_BURN     the Burner's cap per burnEpoch, wei (> 0)                                required
///           SPARE_PAY_CAP_ETH    V2's cap on the ETH value of SPARE-paid jobs per epoch, wei              required
///
///         Built-in defaults of the contracts (decided by the owner on 26-27 Nov 2026): split 350 treasury / 0 burner
///         / 150 holder pool, SPARE discount 0, SPARE sale and burn slippage 400 bps. SPARE payments stay closed until
///         the Safe calls setReferenceSparePrice on V2.
contract DeployV2 is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    struct Deployed {
        UniswapV4SpareAdapter adapter;
        SparecycleBurner burner;
        SparecycleJobPaymentsV2 payments;
        SparecycleHolderPool holderPool;
    }

    struct Config {
        address rewards;
        address treasury;
        address spare;
        bool hasBurn;
        address poolManager;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint256 maxBurn;
        uint256 spareCap;
    }

    function _config() internal view returns (Config memory c) {
        c.rewards = vm.envAddress("REWARD_CONTRACT");
        c.treasury = vm.envAddress("TREASURY");
        c.spare = vm.envAddress("SPARE_TOKEN");
        c.hasBurn = vm.envBool("SPARE_HAS_BURN");
        c.poolManager = vm.envAddress("V4_POOL_MANAGER");
        uint256 fee = vm.envUint("V4_POOL_FEE");
        int256 tickSpacing = vm.envInt("V4_TICK_SPACING");
        require(fee <= type(uint24).max, "V4_POOL_FEE out of range");
        require(tickSpacing > 0 && tickSpacing <= type(int24).max, "V4_TICK_SPACING out of range");
        c.fee = uint24(fee);
        c.tickSpacing = int24(tickSpacing);
        c.hooks = vm.envAddress("V4_HOOKS");
        c.maxBurn = vm.envUint("MAX_ETH_PER_BURN");
        c.spareCap = vm.envUint("SPARE_PAY_CAP_ETH");

        require(c.maxBurn > 0, "MAX_ETH_PER_BURN must be > 0");
        require(c.rewards.code.length > 0, "REWARD_CONTRACT has no code on this chain");
        require(c.spare.code.length > 0, "SPARE_TOKEN has no code on this chain");
        require(c.poolManager.code.length > 0, "V4_POOL_MANAGER has no code on this chain");
        require(IRewardsView(c.rewards).scheduler() != address(0), "REWARD_CONTRACT has no scheduler");
        require(IRewardsView(c.rewards).payoutToken() == address(0), "REWARD_CONTRACT must pay out in ETH");
        if (block.chainid == ROBINHOOD_CHAIN_ID) {
            require(c.treasury.code.length > 0, "mainnet: TREASURY must be the Safe multisig (a contract)");
            require(IRewardsView(c.rewards).owner() == c.treasury, "mainnet: TREASURY must be the reward contract's owner (the Safe)");
        }
    }

    function _check(Deployed memory d, Config memory c, address v2At, address poolAt) internal view {
        require(address(d.payments) == v2At && address(d.holderPool) == poolAt, "address prediction");
        require(address(d.burner.priceSource()) == address(d.payments), "burner -> V2");
        require(d.payments.burner() == address(d.burner) && d.payments.holderPool() == address(d.holderPool), "V2 wiring");
        require(address(d.holderPool.payments()) == address(d.payments), "pool -> V2");
        require(
            d.payments.treasury() == c.treasury && d.burner.treasury() == c.treasury && d.holderPool.treasury() == c.treasury,
            "treasury"
        );
        (uint16 t, uint16 b, uint16 h) = d.payments.currentSplit();
        require(t == 350 && b == 0 && h == 150, "split 350 / 0 / 150");
        require(d.payments.SPARE_DISCOUNT_BPS() == 0, "SPARE discount 0");
        require(d.payments.maxSwapSlippageBps() == 400 && d.burner.maxSlippageBps() == 400, "slippage 400 bps");
        require(d.payments.spareCapEthPerEpoch() == c.spareCap && d.payments.referenceSparePrice() == 0, "SPARE cap / no reference yet");
    }

    function run() external returns (Deployed memory d) {
        Config memory c = _config();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint64 n = vm.getNonce(deployer);
        address v2At = vm.computeCreateAddress(deployer, n + 2);
        address poolAt = vm.computeCreateAddress(deployer, n + 3);

        d.adapter = new UniswapV4SpareAdapter(c.poolManager, c.spare, c.fee, c.tickSpacing, c.hooks);
        d.burner = new SparecycleBurner(c.rewards, c.treasury, c.spare, address(d.adapter), v2At, c.hasBurn, c.maxBurn);
        d.payments = new SparecycleJobPaymentsV2(
            c.rewards, c.treasury, address(d.burner), poolAt, c.spare, address(d.adapter), c.spareCap
        );
        d.holderPool = new SparecycleHolderPool(c.rewards, address(d.payments), c.treasury);
        vm.stopBroadcast();

        _check(d, c, v2At, poolAt);
        _log(d, c, deployer);
    }

    function _log(Deployed memory d, Config memory c, address deployer) internal view {
        (uint16 t, uint16 b, uint16 h) = d.payments.currentSplit();
        console2.log("INTERNAL REVIEW ONLY - NOT EXTERNALLY AUDITED");
        console2.log("chain id                      ", block.chainid);
        console2.log("deployer                      ", deployer);
        console2.log("UniswapV4SpareAdapter         ", address(d.adapter));
        console2.log("SparecycleBurner              ", address(d.burner));
        console2.log("SparecycleJobPaymentsV2       ", address(d.payments));
        console2.log("SparecycleHolderPool          ", address(d.holderPool));
        console2.log("rewards                       ", c.rewards);
        console2.log("rewards scheduler             ", IRewardsView(c.rewards).scheduler());
        console2.log("rewards epoch                 ", IRewardsView(c.rewards).currentEpoch());
        console2.log("treasury (Safe)               ", c.treasury);
        console2.log("split treasury / burner / pool", t, b, h);
        console2.log("SPARE discount bps            ", d.payments.SPARE_DISCOUNT_BPS());
        console2.log("SPARE sale slippage bps       ", d.payments.maxSwapSlippageBps());
        console2.log("SPARE pay cap wei per epoch   ", c.spareCap);
        console2.log("max ETH per burn wei          ", c.maxBurn);
        console2.log("SPARE has burn()              ", c.hasBurn);
        console2.log("pool next postable epoch      ", d.holderPool.nextPostableEpoch());
    }
}
