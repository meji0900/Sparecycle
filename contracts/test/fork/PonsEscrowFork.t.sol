// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {IPonsFeeEscrow} from "../../src/interfaces/IPonsFeeEscrow.sol";

/// @dev Pons v2 factory fragment. Struct layouts and `launchToken` from https://docs.ponsfamily.com/v2
///      ("Launching a token"); the selector is asserted against 0xf35abbcf, which is in the factory bytecode.
interface IPonsFactory {
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
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

/// @dev Curve fragment from the docs ("Buying and selling"). `sweepFees(uint256)` has no typed signature in the
///      docs; its selector 0x3729bb9a is asserted to be in the deployed curve bytecode before it is called.
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
}

/// @dev Pons fee-sweep operator, resolved live from the hook (`feeSweepOperator()`). Selectors read from the
///      deployed bytecode (not in the docs): `sweepCurve(address)` 0xe6b71b11 on the operator,
///      `feeSweepOperator()` 0x8a36a6bb on the hook. Used only to observe who can sweep.
interface IPonsSweepOperator {
    function sweepCurve(address curve) external;
}

interface IPonsHookOperator {
    function feeSweepOperator() external view returns (address);
}

/// @dev Undocumented but deployed: `credit(address)` (0xd5d44d80) is in the escrow's dispatch table, payable,
///      with no caller check (bytecode read). Used here only to put a native balance in the escrow for the
///      reward contract without a launch.
interface IPonsEscrowCredit {
    function credit(address recipient) external payable;
}

/// @title PonsEscrowForkTest
/// @notice Robinhood Chain mainnet fork (chain id 4663): the reward contract as Pons `creatorFeeRecipient`.
///         Local simulation only — nothing is broadcast. Skipped unless `FORK_TESTS=1`.
///         Run: FORK_TESTS=1 forge test --match-path 'test/fork/*' -vv
contract PonsEscrowForkTest is Test {
    address internal constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    bytes4 internal constant NOT_FEE_SWEEP_OPERATOR = 0x8d42130c; // NotFeeSweepOperator()
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes4 internal constant NO_BALANCE = 0xc2caa2a6; // NoBalance()
    bytes4 internal constant SWEEP_FEES = 0x3729bb9a; // sweepFees(uint256)
    bytes4 internal constant QUOTE_FEE_BALANCE = 0xed479c47; // quoteFeeBalance()
    bytes4 internal constant CREATOR_TAX_BALANCE = 0xdb2bd533; // creatorTaxBalance()
    bytes4 internal constant PROTOCOL_FEE_SHARE_BPS = 0x9040f866; // protocolFeeShareBps() (in curve bytecode)

    address internal admin = makeAddr("fork-admin");
    address internal sched = makeAddr("fork-scheduler");
    SparecycleRewards internal r;

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("robinhood");
        r = new SparecycleRewards(admin, sched, address(0), ESCROW, 1 days);
    }

    /// @dev True if `code` contains `PUSH4 sel` (how solc dispatchers compare selectors).
    function _hasSelector(address target, bytes4 sel) internal view returns (bool) {
        bytes memory code = target.code;
        for (uint256 i; i + 4 < code.length; ++i) {
            if (
                code[i] == 0x63 && code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2]
                    && code[i + 4] == sel[3]
            ) return true;
        }
        return false;
    }

    function _readUint(address target, bytes4 sel) internal view returns (bool ok, uint256 v) {
        bytes memory ret;
        (ok, ret) = target.staticcall(abi.encodeWithSelector(sel));
        ok = ok && ret.length == 32;
        if (ok) v = abi.decode(ret, (uint256));
    }

    function _readUintOrZero(address target, bytes4 sel) internal view returns (uint256 v) {
        (, v) = _readUint(target, sel);
    }

    function test_Fork_ChainAndCode() public view {
        assertEq(block.chainid, 4663, "Robinhood Chain mainnet");
        assertGt(ESCROW.code.length, 0, "escrow deployed");
        assertGt(FACTORY.code.length, 0, "factory deployed");
        assertTrue(_hasSelector(ESCROW, IPonsFeeEscrow.claim.selector));
        assertTrue(_hasSelector(ESCROW, IPonsFeeEscrow.claimToken.selector));
        assertTrue(_hasSelector(ESCROW, IPonsFeeEscrow.balanceOf.selector));
        assertTrue(_hasSelector(ESCROW, IPonsFeeEscrow.balanceOfToken.selector));
        assertTrue(_hasSelector(ESCROW, IPonsEscrowCredit.credit.selector));
        assertTrue(_hasSelector(FACTORY, IPonsFactory.launchToken.selector));
        assertEq(IPonsFactory.launchToken.selector, bytes4(0xf35abbcf));
    }

    /// @notice Fresh reward contract: escrow balance 0; the real escrow REVERTS `NoBalance()` on a zero-balance
    ///         claim, and `claimFeesFromEscrow()` handles that by checking `balanceOf` first (returns 0).
    function test_Fork_ZeroBalance_RealEscrowRevertsAndContractReturnsZero() public {
        assertEq(IPonsFeeEscrow(ESCROW).balanceOf(address(r)), 0, "balanceOf(reward) == 0");
        assertEq(IPonsFeeEscrow(ESCROW).balanceOfToken(address(r), USDG), 0);

        vm.prank(address(r));
        (bool ok, bytes memory err) = ESCROW.call(abi.encodeCall(IPonsFeeEscrow.claim, ()));
        assertFalse(ok, "real escrow reverts on zero balance");
        assertEq(bytes4(err), NO_BALANCE, "with NoBalance()");
        console2.log("observed: escrow.claim() with zero balance reverts NoBalance() (0xc2caa2a6)");

        vm.prank(address(r));
        (ok, err) = ESCROW.call(abi.encodeCall(IPonsFeeEscrow.claimToken, (USDG)));
        assertFalse(ok);
        assertEq(bytes4(err), NO_BALANCE);
        console2.log("observed: escrow.claimToken(USDG) with zero balance reverts NoBalance()");

        uint256 credited = r.claimFeesFromEscrow();
        assertEq(credited, 0, "contract pre-checks balanceOf and returns 0 instead of reverting");
        assertEq(r.accounted(), 0);
    }

    /// @notice Real escrow pays the reward contract (full-gas CALL into the empty receive) and the pot grows.
    function test_Fork_RealEscrowPaysRewardContract() public {
        address payer = makeAddr("fork-payer");
        vm.deal(payer, 2 ether);
        vm.prank(payer);
        IPonsEscrowCredit(ESCROW).credit{value: 1.5 ether}(address(r));
        assertEq(IPonsFeeEscrow(ESCROW).balanceOf(address(r)), 1.5 ether, "credited in escrow");

        uint256 g = gasleft();
        uint256 credited = r.claimFeesFromEscrow();
        console2.log("gas: claimFeesFromEscrow() against the real escrow", g - gasleft());
        assertEq(credited, 1.5 ether);
        assertEq(IPonsFeeEscrow(ESCROW).balanceOf(address(r)), 0, "escrow balance cleared");
        assertEq(address(r).balance, 1.5 ether);
        assertEq(r.getEpoch(0).pot, 1.5 ether, "pot grew");
        assertEq(r.accounted(), 1.5 ether);
        assertEq(r.claimFeesFromEscrow(), 0, "second call is a no-op");
    }

    /// @dev Launches a throwaway ETH-pair token with the reward contract as creatorFeeRecipient.
    function _launch(address launcher) internal returns (address curve) {
        IPonsFactory f = IPonsFactory(FACTORY);
        IPonsFactory.TokenParams memory p;
        p.name = "Sparecycle Fork Test";
        p.symbol = "SCFORK";
        p.description = "throwaway fork-only launch, never broadcast";
        p.creatorFeeRecipient = address(r);
        p.creatorTaxBps = 0;
        p.buybackEnabled = false;
        p.expectedEconomics = f.previewLaunchEconomics(0, address(0));
        p.salt = keccak256("sparecycle-fork-test");

        uint256 fee = f.launchFee();
        vm.prank(launcher);
        address token;
        (token, curve) = f.launchToken{value: fee}(p, 0, address(0));
        console2.log("launched token", token);
        console2.log("curve", curve);

        IPonsFactory.LaunchedToken memory lt = f.getLaunchedToken(token);
        assertTrue(lt.exists);
        assertEq(lt.curve, curve, "curve resolved via getLaunchedToken");
        assertEq(lt.creatorFeeRecipient, address(r), "reward contract is creatorFeeRecipient");
        assertEq(lt.deployer, launcher, "deployer = launcher");
        assertEq(lt.pairToken, address(0), "ETH pair");
        assertFalse(lt.buybackEnabled);
        assertEq(lt.creatorTaxBps, 0);
        assertTrue(_hasSelector(curve, IPonsCurve.buy.selector), "buy selector in curve code");
        assertTrue(_hasSelector(curve, SWEEP_FEES), "sweepFees(uint256) selector in curve code");
    }

    /// @dev Buys 1 ETH of the token after the 5 s snipe-tax window; returns the curve fee balance.
    function _buy(address curve) internal returns (uint256 quoteFees) {
        vm.warp(block.timestamp + 60);
        address buyer = makeAddr("fork-buyer");
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        uint256 out = IPonsCurve(curve).buy{value: 1 ether}(1 ether, 0, buyer);
        assertGt(out, 0, "bought tokens");
        bool okQ;
        (okQ, quoteFees) = _readUint(curve, QUOTE_FEE_BALANCE);
        (bool okT, uint256 taxBal) = _readUint(curve, CREATOR_TAX_BALANCE);
        assertTrue(okQ && okT, "fee views readable as uint256");
        console2.log("curve.quoteFeeBalance() after a 1 ETH buy (wei)", quoteFees);
        console2.log("curve.creatorTaxBalance() (wei, tax = 0 bps)", taxBal);
    }

    /// @dev Records who may sweep a pre-graduation curve. Leaves state unchanged.
    function _observeSweepAccess(address curve, address launcher) internal {
        bytes memory sweepCall = abi.encodeWithSelector(SWEEP_FEES, uint256(0));
        vm.prank(launcher);
        (bool ok, bytes memory err) = curve.call(sweepCall);
        assertFalse(ok, "launcher cannot sweep");
        assertEq(bytes4(err), NOT_FEE_SWEEP_OPERATOR, "NotFeeSweepOperator()");
        console2.log("observed: curve.sweepFees(0) from the launcher reverts NotFeeSweepOperator()");

        address bot = makeAddr("fork-sweep-bot");
        vm.prank(bot);
        (ok, err) = curve.call(sweepCall);
        assertFalse(ok, "random EOA cannot sweep the curve directly");
        assertEq(bytes4(err), NOT_FEE_SWEEP_OPERATOR);
        console2.log("observed: curve.sweepFees(0) from a random EOA reverts NotFeeSweepOperator()");

        // The creatorFeeRecipient may sweep directly (pranked: the reward contract has no sweep function).
        uint256 snap = vm.snapshotState();
        vm.prank(address(r));
        (ok,) = curve.call(sweepCall);
        assertTrue(ok, "creatorFeeRecipient can sweep");
        console2.log("observed: curve.sweepFees(0) as creatorFeeRecipient (reward contract, pranked) succeeds");
        vm.revertToState(snap);
    }

    /// @notice Stretch: launch a throwaway token through the real factory with the reward contract as
    ///         creatorFeeRecipient, buy on the curve, sweep, claim from escrow, and see the pot grow.
    function test_Fork_LaunchBuySweepClaim() public {
        IPonsFactory f = IPonsFactory(FACTORY);
        address launcher = makeAddr("fork-launcher");
        vm.deal(launcher, 10 ether);
        if (!f.launchEnabled() || !f.canLaunch(launcher)) {
            console2.log("launches gated for this address on the fork block; skipping launch path");
            vm.skip(true);
            return;
        }
        address curve = _launch(launcher);
        uint256 quoteFees = _buy(curve);
        _observeSweepAccess(curve, launcher);

        // Sweep the way the sweep bot will: through the Pons fee-sweep operator (resolved from the hook),
        // which is callable by anyone at this fork block. No sweep function is needed on the reward contract.
        address operator = IPonsHookOperator(HOOK).feeSweepOperator();
        console2.log("hook.feeSweepOperator()", operator);
        assertTrue(_hasSelector(operator, IPonsSweepOperator.sweepCurve.selector), "sweepCurve in operator code");
        uint256 escBefore = IPonsFeeEscrow(ESCROW).balanceOf(address(r));
        vm.prank(makeAddr("fork-sweep-bot"));
        IPonsSweepOperator(operator).sweepCurve(curve);
        console2.log("observed: operator.sweepCurve(curve) from a random EOA succeeds");
        assertEq(_readUintOrZero(curve, QUOTE_FEE_BALANCE), 0, "curve fee balance swept");

        uint256 escAfter = IPonsFeeEscrow(ESCROW).balanceOf(address(r));
        (bool okS, uint256 shareBps) = _readUint(curve, PROTOCOL_FEE_SHARE_BPS);
        assertTrue(okS, "protocolFeeShareBps() readable");
        console2.log("curve.protocolFeeShareBps()", shareBps);
        console2.log("escrow credit to reward contract from the sweep (wei)", escAfter - escBefore);
        assertEq(escAfter - escBefore, (quoteFees * (10_000 - shareBps)) / 10_000, "creator share of the fee");

        uint256 potBefore = r.getEpoch(0).pot;
        uint256 credited = r.claimFeesFromEscrow();
        assertEq(credited, escAfter, "claimed the whole escrow balance");
        assertEq(r.getEpoch(0).pot, potBefore + credited, "pot grew");
        assertEq(r.accounted(), address(r).balance, "accounted == balance");
        console2.log("pot after claimFeesFromEscrow (wei)", r.getEpoch(0).pot);
    }
}
