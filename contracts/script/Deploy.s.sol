// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {MockPonsFeeEscrow} from "../test/mocks/MockPonsFeeEscrow.sol";

/// @title Deploy
/// @notice Deploys SparecycleRewards. Constructor args come from env; the signer comes from the forge CLI
///         (`--account <keystore>` / `--ledger` / `--unlocked` on anvil). No key is ever read here.
///
///         Env:
///           ADMIN               owner (intended: the multisig)                         required
///           SCHEDULER           root-posting key                                        required
///           EPOCH_LENGTH        seconds, 1..365 days                                    required
///           PAYOUT_TOKEN        ERC-20 payout token, default address(0) = ETH          optional
///           FEE_ESCROW          default the Pons v2 fee escrow on Robinhood Chain       optional
///           DEPLOY_MOCK_ESCROW  1 = deploy MockPonsFeeEscrow and use it                 optional
///                               (anvil 31337, or Robinhood testnet 46630 where Pons is not deployed;
///                               refused on mainnet and every other chain)
contract Deploy is Script {
    address internal constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;

    function run() external returns (SparecycleRewards rewards, MockPonsFeeEscrow mockEscrow) {
        address admin = vm.envAddress("ADMIN");
        address scheduler = vm.envAddress("SCHEDULER");
        uint256 epochLength = vm.envUint("EPOCH_LENGTH");
        address payoutToken = vm.envOr("PAYOUT_TOKEN", address(0));
        address feeEscrow = vm.envOr("FEE_ESCROW", PONS_FEE_ESCROW);
        bool deployMock = vm.envOr("DEPLOY_MOCK_ESCROW", uint256(0)) == 1;

        require(epochLength > 0 && epochLength <= type(uint64).max, "EPOCH_LENGTH out of range");
        if (deployMock) {
            require(
                block.chainid == ANVIL_CHAIN_ID || block.chainid == ROBINHOOD_TESTNET_CHAIN_ID,
                "DEPLOY_MOCK_ESCROW=1 is for anvil (31337) or Robinhood testnet (46630) only"
            );
        }
        if (block.chainid == ROBINHOOD_CHAIN_ID) {
            require(feeEscrow == PONS_FEE_ESCROW, "mainnet: FEE_ESCROW must be the Pons v2 fee escrow");
            require(admin != scheduler, "mainnet: ADMIN (multisig) and SCHEDULER must differ");
        }
        if (!deployMock) require(feeEscrow.code.length > 0, "FEE_ESCROW has no code on this chain");

        vm.startBroadcast();
        if (deployMock) {
            mockEscrow = new MockPonsFeeEscrow();
            feeEscrow = address(mockEscrow);
        }
        rewards = new SparecycleRewards(admin, scheduler, payoutToken, feeEscrow, uint64(epochLength));
        vm.stopBroadcast();

        console2.log("chain id          ", block.chainid);
        console2.log("SparecycleRewards ", address(rewards));
        if (deployMock) console2.log("MockPonsFeeEscrow ", address(mockEscrow));
        console2.log("owner (admin)     ", admin);
        console2.log("scheduler         ", scheduler);
        console2.log("payout token      ", payoutToken == address(0) ? "ETH (address(0))" : vm.toString(payoutToken));
        console2.log("fee escrow        ", feeEscrow);
        console2.log("epoch length (s)  ", epochLength);
    }
}
