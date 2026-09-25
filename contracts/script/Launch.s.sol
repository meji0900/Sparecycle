// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {PonsLaunch} from "./PonsLaunch.sol";

/// @title Launch
/// @notice Launches the Sparecycle token on Pons v2 (Robinhood Chain mainnet) with the deployed reward contract as
///         creatorFeeRecipient. The signer comes from the forge CLI (`--account <keystore>`); no key is read here.
///         Env: REWARD_CONTRACT (the deployed SparecycleRewards) plus the PonsLaunch env.
///         Run it through `node scripts/mainnet.mjs launch`, which simulates first and asks before broadcasting.
contract Launch is PonsLaunch {
    function run() external returns (address token, address curve) {
        SparecycleRewards reward = SparecycleRewards(payable(vm.envAddress("REWARD_CONTRACT")));
        vm.startBroadcast();
        (token, curve) = _launch(reward);
        vm.stopBroadcast();
    }
}
