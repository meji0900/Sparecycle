// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";

/// @dev Pons v2 factory fragment, the same layouts as test/fork/PonsEscrowFork.t.sol (asserted there against the
///      deployed bytecode: launchToken 0xf35abbcf). Source: https://docs.ponsfamily.com/v2 ("Launching a token").
interface IPonsFactoryLaunch {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
    function canLaunch(address account) external view returns (bool);
    function maxCreatorTaxBps() external view returns (uint256);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function getLaunchedToken(address token) external view returns (IPonsFactoryLaunch.LaunchedToken memory);
}

/// @title PonsLaunch
/// @notice The Sparecycle launch rules in one place, shared by Launch.s.sol and Rehearse.s.sol:
///         the reward contract is the creatorFeeRecipient, buybacks are off, the 3-argument launchToken (no extra
///         snipe-tax exemptions, no initial buy: nobody holds tokens before trading opens), and the pair asset equals
///         the reward contract's payout asset, because Pons pays curve fees in the pair asset.
///
///         Env:
///           TOKEN_NAME, TOKEN_SYMBOL                                          required
///           CREATOR_TAX_BPS     0..maxCreatorTaxBps(); fixed at launch          required
///           PAIR_ASSET          ETH | USDG; must match the payout asset         required
///           LAUNCH_CONFIG_ID    default 0
///           TOKEN_LOGO, TOKEN_DESCRIPTION, TOKEN_TWITTER, TOKEN_TELEGRAM, TOKEN_DISCORD, TOKEN_WEBSITE,
///           TOKEN_FARCASTER     optional strings
///           LAUNCH_SALT         optional bytes32; default keccak256("sparecycle-launch", symbol, reward contract)
abstract contract PonsLaunch is Script {
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    /// @dev ETH -> address(0), USDG -> USDG. Anything else reverts.
    function _pairToken(string memory asset) internal pure returns (address) {
        bytes32 h = keccak256(bytes(asset));
        if (h == keccak256("ETH")) return address(0);
        if (h == keccak256("USDG")) return USDG;
        revert("PAIR_ASSET must be ETH or USDG");
    }

    function _params(SparecycleRewards reward, address pairToken, uint256 configId)
        internal
        view
        returns (IPonsFactoryLaunch.TokenParams memory p)
    {
        p.name = vm.envString("TOKEN_NAME");
        p.symbol = vm.envString("TOKEN_SYMBOL");
        require(bytes(p.name).length > 0 && bytes(p.name).length <= 64, "TOKEN_NAME: 1..64 bytes");
        require(bytes(p.symbol).length > 0 && bytes(p.symbol).length <= 16, "TOKEN_SYMBOL: 1..16 bytes");
        p.logo = vm.envOr("TOKEN_LOGO", string(""));
        p.description = vm.envOr("TOKEN_DESCRIPTION", string(""));
        p.socials = IPonsFactoryLaunch.Socials({
            twitter: vm.envOr("TOKEN_TWITTER", string("")),
            telegram: vm.envOr("TOKEN_TELEGRAM", string("")),
            discord: vm.envOr("TOKEN_DISCORD", string("")),
            website: vm.envOr("TOKEN_WEBSITE", string("")),
            farcaster: vm.envOr("TOKEN_FARCASTER", string(""))
        });
        uint256 tax = vm.envUint("CREATOR_TAX_BPS");
        require(tax <= IPonsFactoryLaunch(PONS_FACTORY).maxCreatorTaxBps(), "CREATOR_TAX_BPS above maxCreatorTaxBps()");
        p.creatorTaxBps = uint16(tax);
        p.creatorFeeRecipient = address(reward);
        p.buybackEnabled = false;
        // Read immediately before the launch: a config change in between reverts LaunchEconomicsMismatch.
        p.expectedEconomics = IPonsFactoryLaunch(PONS_FACTORY).previewLaunchEconomics(configId, pairToken);
        p.salt = vm.envOr("LAUNCH_SALT", keccak256(abi.encode("sparecycle-launch", p.symbol, address(reward))));
    }

    /// @notice Launches the token from the current broadcaster. Call between vm.startBroadcast() and stopBroadcast().
    function _launch(SparecycleRewards reward) internal returns (address token, address curve) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "Pons v2 runs on Robinhood Chain (4663) only");
        IPonsFactoryLaunch f = IPonsFactoryLaunch(PONS_FACTORY);
        address pairToken = _pairToken(vm.envString("PAIR_ASSET"));
        uint256 configId = vm.envOr("LAUNCH_CONFIG_ID", uint256(0));

        require(address(reward).code.length > 0, "reward contract has no code");
        require(reward.feeEscrow() == PONS_FEE_ESCROW, "reward.feeEscrow() is not the Pons v2 fee escrow");
        require(reward.payoutToken() == pairToken, "PAIR_ASSET must equal the reward contract's payout asset");
        (, address launcher,) = vm.readCallers();
        require(f.launchEnabled(), "Pons launches are disabled");
        require(f.canLaunch(launcher), "this wallet may not launch (factory canLaunch = false)");
        if (pairToken != address(0)) require(f.approvedPairTokens(pairToken), "pair token not approved by Pons");

        IPonsFactoryLaunch.TokenParams memory p = _params(reward, pairToken, configId);
        uint256 fee = f.launchFee();
        (token, curve) = f.launchToken{value: fee}(p, configId, pairToken);

        IPonsFactoryLaunch.LaunchedToken memory lt = f.getLaunchedToken(token);
        require(lt.exists && lt.curve == curve, "launch not recorded by the factory");
        require(lt.creatorFeeRecipient == address(reward), "creatorFeeRecipient is not the reward contract");
        require(!lt.buybackEnabled, "buyback is on");
        require(lt.pairToken == pairToken && lt.creatorTaxBps == p.creatorTaxBps, "launch terms differ");

        console2.log("launcher          ", launcher);
        console2.log("launch fee (wei)  ", fee);
        console2.log("token             ", token);
        console2.log("curve             ", curve);
        console2.log("name / symbol     ", string.concat(p.name, " / ", p.symbol));
        console2.log("creator tax (bps) ", p.creatorTaxBps);
        console2.log("pair token        ", pairToken == address(0) ? "ETH (address(0))" : vm.toString(pairToken));
        console2.log("fee recipient     ", lt.creatorFeeRecipient);
    }
}
