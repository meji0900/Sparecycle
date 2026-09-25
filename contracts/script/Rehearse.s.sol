// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/Script.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {PonsLaunch} from "./PonsLaunch.sol";

/// @dev Pons fee-sweep path, resolved live (selectors from bytecode, see test/fork/PonsEscrowFork.t.sol).
interface IPonsHookOp {
    function feeSweepOperator() external view returns (address);
}

interface IPonsSweepOp {
    function sweepCurve(address curve) external;
}

interface IPonsCurveBuy {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
}

/// @title Rehearse
/// @notice Dry run of the whole mainnet launch from the real wallet, against live mainnet state, in forge's local
///         simulation: deploy SparecycleRewards, launch the token with it as creatorFeeRecipient, then (outside the
///         broadcast, so not counted as the wallet's transactions) a test buy, the Pons operator sweep and
///         claimFeesFromEscrow, to show fees reach the pot. Refuses to run with --broadcast.
///         Env: the Deploy env (ADMIN, SCHEDULER, EPOCH_LENGTH, PAYOUT_TOKEN) plus the PonsLaunch env.
contract Rehearse is PonsLaunch {
    address internal constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function run() external returns (SparecycleRewards reward, address token, address curve) {
        require(vm.isContext(VmSafe.ForgeContext.ScriptDryRun), "Rehearse is a dry run only: run it without --broadcast");
        address admin = vm.envAddress("ADMIN");
        address scheduler = vm.envAddress("SCHEDULER");
        uint256 epochLength = vm.envUint("EPOCH_LENGTH");
        address payoutToken = vm.envOr("PAYOUT_TOKEN", address(0));
        require(admin != scheduler, "mainnet: ADMIN and SCHEDULER must differ");

        vm.startBroadcast();
        reward = new SparecycleRewards(admin, scheduler, payoutToken, PONS_FEE_ESCROW, uint64(epochLength));
        (token, curve) = _launch(reward);
        vm.stopBroadcast();
        console2.log("SparecycleRewards ", address(reward));

        // Outside the broadcast: a stranger buys 0.1 ETH, anyone sweeps, the pot grows. ETH pair only.
        if (payoutToken == address(0)) {
            address buyer = makeAddr("rehearsal-buyer");
            vm.deal(buyer, 1 ether);
            vm.prank(buyer);
            IPonsCurveBuy(curve).buy{value: 0.1 ether}(0.1 ether, 0, buyer);
            address op = IPonsHookOp(PONS_HOOK).feeSweepOperator();
            vm.prank(makeAddr("rehearsal-sweeper"));
            IPonsSweepOp(op).sweepCurve(curve);
            uint256 claimed = reward.claimFeesFromEscrow();
            console2.log("test buy (wei)    ", uint256(0.1 ether));
            console2.log("fees into pot     ", claimed);
            console2.log("epoch 0 pot       ", reward.getEpoch(0).pot);
            require(claimed > 0 && reward.getEpoch(0).pot == claimed, "fees did not reach the pot");
        }
    }
}
