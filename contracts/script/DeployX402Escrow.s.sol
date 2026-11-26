// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SparecycleX402Escrow} from "../src/SparecycleX402Escrow.sol";

interface IRewardsView {
    function owner() external view returns (address);
    function scheduler() external view returns (address);
    function payoutToken() external view returns (address);
    function currentEpoch() external view returns (uint64);
}

interface IEIP3009View {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function decimals() external view returns (uint8);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title DeployX402Escrow
/// @notice INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. Deploys SparecycleX402Escrow (x402 pay-per-job, option X1)
///         next to the live SparecycleRewards. The signer comes from the forge CLI (`--account <keystore>`); no key is
///         read here. Without `--broadcast` forge only simulates (the dry-run in docs/x402-decision.md).
///
///         Env (no address or cap has a guessed default):
///           REWARD_CONTRACT                the live SparecycleRewards (src/lib/addresses.ts ADDR.rewards)     required
///           X402_ASSET                     the EIP-3009 payment asset                                          required
///           X402_ASSET_NAME                its EIP-712 domain name (checked against DOMAIN_SEPARATOR)          required
///           X402_ASSET_VERSION             its EIP-712 domain version (checked against DOMAIN_SEPARATOR)       required
///           X402_MAX_PER_JOB               cap per escrow, asset units                                         required
///           X402_MAX_TOTAL_HELD            cap on all held escrows, asset units                                required
///           X402_MAX_PER_PAYER_PER_EPOCH   cap per payer per reward epoch, asset units                         required
///           TREASURY                       receives 5% of forwarded payments  default contracts/mainnet.json treasury.safe
///           ADMIN                          owner (sets caps / forwardTo)      default contracts/mainnet.json treasury.safe
///           X402_FORWARD_TO                receives the pot share for conversion to the pot's asset
///                                          default contracts/mainnet.json treasury.safe
///           X402_SETTLE_WINDOW             seconds from funding to the refund deadline, default 43200 (the 6 h job TTL
///                                          plus 6 h for the settlement transaction)
///
///         On Robinhood Chain mainnet (4663): the owner, treasury and forwardTo must be contracts (the Safe), the owner
///         must be the reward contract's owner, and the asset must answer EIP-3009 `authorizationState`.
contract DeployX402Escrow is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint64 internal constant DEFAULT_SETTLE_WINDOW = 12 hours;

    function run() external returns (SparecycleX402Escrow escrow) {
        address safe = _mainnetSafe();
        address rewards = vm.envAddress("REWARD_CONTRACT");
        address asset = vm.envAddress("X402_ASSET");
        string memory assetName = vm.envString("X402_ASSET_NAME");
        string memory assetVersion = vm.envString("X402_ASSET_VERSION");
        address admin = vm.envOr("ADMIN", safe);
        address treasury = vm.envOr("TREASURY", safe);
        address forwardTo = vm.envOr("X402_FORWARD_TO", safe);
        uint256 window = vm.envOr("X402_SETTLE_WINDOW", uint256(DEFAULT_SETTLE_WINDOW));
        uint256[3] memory caps =
            [vm.envUint("X402_MAX_PER_JOB"), vm.envUint("X402_MAX_TOTAL_HELD"), vm.envUint("X402_MAX_PER_PAYER_PER_EPOCH")];

        require(admin != address(0) && treasury != address(0) && forwardTo != address(0), "set ADMIN / TREASURY / X402_FORWARD_TO");
        require(window <= type(uint64).max, "X402_SETTLE_WINDOW out of range");
        require(rewards.code.length > 0, "REWARD_CONTRACT has no code on this chain");
        require(asset.code.length > 0, "X402_ASSET has no code on this chain");
        require(IRewardsView(rewards).scheduler() != address(0), "REWARD_CONTRACT has no scheduler");

        // The asset's EIP-712 domain must be the one x402 clients sign for (name, version, this chain, the asset).
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(assetName)),
                keccak256(bytes(assetVersion)),
                block.chainid,
                asset
            )
        );
        require(IEIP3009View(asset).DOMAIN_SEPARATOR() == expected, "X402_ASSET_NAME / X402_ASSET_VERSION do not match the asset's DOMAIN_SEPARATOR");
        // EIP-3009 present: authorizationState answers (a token without it reverts or returns nothing).
        (bool ok, bytes memory ret) =
            asset.staticcall(abi.encodeCall(IEIP3009View.authorizationState, (address(1), bytes32(0))));
        require(ok && ret.length == 32, "X402_ASSET does not answer EIP-3009 authorizationState");

        if (block.chainid == ROBINHOOD_CHAIN_ID) {
            require(admin.code.length > 0, "mainnet: ADMIN must be the Safe multisig (a contract)");
            require(treasury.code.length > 0, "mainnet: TREASURY must be the Safe multisig (a contract)");
            require(forwardTo.code.length > 0, "mainnet: X402_FORWARD_TO must be a Safe-controlled contract");
            require(IRewardsView(rewards).owner() == admin, "mainnet: ADMIN must be the reward contract's owner (the Safe)");
        }

        vm.startBroadcast();
        escrow = new SparecycleX402Escrow(admin, rewards, asset, treasury, forwardTo, uint64(window), caps);
        vm.stopBroadcast();

        require(
            address(escrow.rewards()) == rewards && address(escrow.asset()) == asset && escrow.treasury() == treasury
                && escrow.forwardTo() == forwardTo && escrow.owner() == admin && escrow.settleWindow() == window
                && escrow.maxPerJob() == caps[0] && escrow.maxTotalHeld() == caps[1] && escrow.maxPerPayerPerEpoch() == caps[2],
            "read-back mismatch"
        );

        console2.log("INTERNAL REVIEW ONLY - NOT EXTERNALLY AUDITED");
        console2.log("chain id                ", block.chainid);
        console2.log("SparecycleX402Escrow    ", address(escrow));
        console2.log("rewards                 ", rewards);
        console2.log("rewards scheduler       ", IRewardsView(rewards).scheduler());
        console2.log("rewards epoch           ", IRewardsView(rewards).currentEpoch());
        console2.log("asset                   ", asset);
        console2.log("asset decimals          ", IEIP3009View(asset).decimals());
        console2.log("pot paid in the asset   ", escrow.potPaysInAsset());
        console2.log("owner (admin)           ", admin);
        console2.log("treasury                ", treasury);
        console2.log("forwardTo (conversion)  ", forwardTo);
        console2.log("settle window (s)       ", window);
        console2.log("max per job             ", caps[0]);
        console2.log("max total held          ", caps[1]);
        console2.log("max per payer per epoch ", caps[2]);
    }

    /// @dev The treasury Safe recorded in contracts/mainnet.json (zero when the file or the field is absent).
    function _mainnetSafe() internal view returns (address) {
        try vm.readFile("mainnet.json") returns (string memory json) {
            if (vm.keyExistsJson(json, ".treasury.safe")) return vm.parseJsonAddress(json, ".treasury.safe");
        } catch {}
        return address(0);
    }
}
