// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SparecycleNodeStake} from "../src/SparecycleNodeStake.sol";

/// @title DeployNodeStake
/// @notice Deploys SparecycleNodeStake next to the live SparecycleRewards. The signer comes from the forge CLI
///         (`--account <keystore>`); no key is read here. Internal review only, not externally audited.
///
///         Env:
///           SPARE_TOKEN          the staked token (ADDR.spareToken)                               required
///           REWARD_CONTRACT      the live SparecycleRewards: epochs and the scheduler               required
///           TREASURY             the treasury Safe: cancels or executes slashes                     required
///           SPARE_HAS_BURN       true when SPARE has burn(uint256) (else slashes go to 0x…dEaD)     required
///           MIN_STAKE_PER_NODE   initial minimum per active node, in token wei (default 0)          optional
///
///         The windows and the slash cap are the contract's defaults (brief §10, Default, not yet confirmed by Fabio).
contract DeployNodeStake is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    function run() external returns (SparecycleNodeStake stake) {
        address token = vm.envAddress("SPARE_TOKEN");
        address rewards = vm.envAddress("REWARD_CONTRACT");
        address treasury = vm.envAddress("TREASURY");
        bool useBurn = vm.envBool("SPARE_HAS_BURN");
        uint256 minStake = vm.envOr("MIN_STAKE_PER_NODE", uint256(0));
        require(token.code.length > 0, "SPARE_TOKEN has no code on this chain");
        require(rewards.code.length > 0, "REWARD_CONTRACT has no code on this chain");
        if (block.chainid == ROBINHOOD_CHAIN_ID) {
            require(treasury.code.length > 0, "mainnet: TREASURY must be the Safe multisig (a contract), not a wallet");
        }

        // The contract's defaults: slash cap 10%, fault window 8, appeal 4, cooldown 16, decision 12, min-stake delay 1.
        SparecycleNodeStake.Config memory c = SparecycleNodeStake.Config({
            slashBps: 1_000,
            faultWindowEpochs: 8,
            appealWindowEpochs: 4,
            cooldownEpochs: 16,
            decisionWindowEpochs: 12,
            minStakeDelayEpochs: 1
        });

        vm.startBroadcast();
        stake = new SparecycleNodeStake(token, rewards, treasury, useBurn, minStake, c);
        vm.stopBroadcast();

        // Read back what was deployed, and that the config equals the contract's own defaultConfig().
        SparecycleNodeStake.Config memory d = stake.defaultConfig();
        require(
            address(stake.token()) == token && address(stake.rewards()) == rewards && stake.safe() == treasury
                && stake.burnWithBurnFunction() == useBurn && stake.minStakePerNode() == minStake,
            "read-back mismatch"
        );
        require(
            stake.slashBps() == d.slashBps && stake.faultWindowEpochs() == d.faultWindowEpochs
                && stake.appealWindowEpochs() == d.appealWindowEpochs && stake.cooldownEpochs() == d.cooldownEpochs
                && stake.decisionWindowEpochs() == d.decisionWindowEpochs
                && stake.minStakeDelayEpochs() == d.minStakeDelayEpochs,
            "config differs from defaultConfig()"
        );
        console2.log("SparecycleNodeStake", address(stake));
        console2.log("token", token);
        console2.log("rewards", rewards);
        console2.log("safe", treasury);
        console2.log("minStakePerNode", minStake);
    }
}
