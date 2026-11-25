// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function scheduler() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @title TransferOwnership
/// @notice Step 1 of 2 of moving SparecycleRewards' owner to a Safe: the current owner calls
///         `transferOwnership(SAFE)`. Nothing changes until the Safe executes `acceptOwnership()` (selector
///         0x79ba5097) as a Safe transaction; until then the current owner stays owner and can overwrite the pending
///         owner. The signer comes from the forge CLI (`--account <keystore>`); no key is read here.
///
///         Env:
///           REWARD_CONTRACT     the SparecycleRewards to move                      required
///           SAFE                the new owner: a deployed Safe                     required
///           EXPECTED_CHAIN_ID   refuse to run on any other chain (4663 / 46630)    required
///           MIN_THRESHOLD       lowest Safe threshold accepted                      default 2
contract TransferOwnership is Script {
    function run() external {
        address reward = vm.envAddress("REWARD_CONTRACT");
        address safe = vm.envAddress("SAFE");
        require(block.chainid == vm.envUint("EXPECTED_CHAIN_ID"), "wrong chain");
        require(reward.code.length > 0, "REWARD_CONTRACT has no code on this chain");
        require(safe.code.length > 0, "SAFE has no code: never transfer to an undeployed (counterfactual) Safe");

        uint256 threshold = ISafe(safe).getThreshold();
        address[] memory owners = ISafe(safe).getOwners();
        require(threshold >= vm.envOr("MIN_THRESHOLD", uint256(2)), "Safe threshold below MIN_THRESHOLD");
        require(threshold <= owners.length, "Safe threshold above its owner count");

        IOwnable2Step r = IOwnable2Step(reward);
        address current = r.owner();
        require(current != safe, "the Safe is already the owner");
        address scheduler = r.scheduler();

        console2.log("reward contract", reward);
        console2.log("current owner  ", current);
        console2.log("new owner (Safe)", safe);
        console2.log("Safe threshold ", threshold);
        console2.log("Safe owners    ", owners.length);
        for (uint256 i = 0; i < owners.length; i++) console2.log("  owner", owners[i]);

        vm.startBroadcast();
        r.transferOwnership(safe);
        vm.stopBroadcast();

        require(r.pendingOwner() == safe, "pendingOwner read-back mismatch");
        require(r.owner() == current, "owner changed before acceptance");
        require(r.scheduler() == scheduler, "scheduler changed");
        console2.log("pendingOwner   ", r.pendingOwner());
        console2.log("Next: the Safe executes acceptOwnership() on the reward contract (data 0x79ba5097, value 0).");
    }
}
