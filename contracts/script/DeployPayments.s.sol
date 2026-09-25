// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SparecycleJobPayments} from "../src/SparecycleJobPayments.sol";

/// @title DeployPayments
/// @notice Deploys SparecycleJobPayments next to an existing SparecycleRewards. The signer comes from the forge CLI
///         (`--account <keystore>`); no key is read here.
///
///         Env:
///           REWARD_CONTRACT   the live SparecycleRewards (ETH payout)      required
///           TREASURY          receives 5% of every charge: a Safe          required
///
///         On Robinhood Chain mainnet the treasury must be a contract (the Safe), never a plain wallet.
contract DeployPayments is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    function run() external returns (SparecycleJobPayments payments) {
        address rewards = vm.envAddress("REWARD_CONTRACT");
        address treasury = vm.envAddress("TREASURY");
        require(rewards.code.length > 0, "REWARD_CONTRACT has no code on this chain");
        if (block.chainid == ROBINHOOD_CHAIN_ID) {
            require(treasury.code.length > 0, "mainnet: TREASURY must be the Safe multisig (a contract), not a wallet");
        }

        vm.startBroadcast();
        payments = new SparecycleJobPayments(rewards, treasury);
        vm.stopBroadcast();

        require(address(payments.rewards()) == rewards && payments.treasury() == treasury, "read-back mismatch");
        console2.log("SparecycleJobPayments", address(payments));
        console2.log("rewards", rewards);
        console2.log("treasury", treasury);
    }
}
