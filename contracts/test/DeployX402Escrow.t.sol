// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployX402Escrow} from "../script/DeployX402Escrow.s.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {SparecycleX402Escrow} from "../src/SparecycleX402Escrow.sol";
import {MockPonsFeeEscrow} from "./mocks/MockPonsFeeEscrow.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockEIP3009Token} from "./mocks/MockEIP3009.sol";

/// @notice Stands in for a Safe (any contract): the mainnet guards only check that owner / treasury / forwardTo have code.
contract FakeSafe {}

/// @notice Runs the deploy script itself on local mocks (no network): the generic path and the Robinhood mainnet
///         guards (chain id 4663 set in-process).
contract DeployX402EscrowTest is Test {
    DeployX402Escrow internal script;
    MockEIP3009Token internal usdg;
    SparecycleRewards internal rewards;
    address internal safe;
    address internal sched = makeAddr("scheduler");

    function setUp() public {
        script = new DeployX402Escrow();
        safe = address(new FakeSafe());
        usdg = new MockEIP3009Token("Global Dollar", "1", 6);
        rewards = new SparecycleRewards(safe, sched, address(0), address(new MockPonsFeeEscrow()), 6 hours);
        vm.setEnv("REWARD_CONTRACT", vm.toString(address(rewards)));
        vm.setEnv("X402_ASSET", vm.toString(address(usdg)));
        vm.setEnv("X402_ASSET_NAME", "Global Dollar");
        vm.setEnv("X402_ASSET_VERSION", "1");
        vm.setEnv("ADMIN", vm.toString(safe));
        vm.setEnv("TREASURY", vm.toString(safe));
        vm.setEnv("X402_FORWARD_TO", vm.toString(safe));
        vm.setEnv("X402_SETTLE_WINDOW", "43200");
        vm.setEnv("X402_MAX_PER_JOB", "5000000");
        vm.setEnv("X402_MAX_TOTAL_HELD", "500000000");
        vm.setEnv("X402_MAX_PER_PAYER_PER_EPOCH", "50000000");
    }

    /// @dev One sequential test: vm.setEnv is process-wide and forge runs test functions in parallel.
    function test_deployScript() public {
        _deploysWithTheEnvValues();
        _refusesAWrongEip712Domain();
        _refusesATokenWithoutEip3009();
        _missingCapIsAnError();
        _mainnetGuards();
    }

    function _deploysWithTheEnvValues() internal {
        SparecycleX402Escrow e = script.run();
        assertEq(address(e.rewards()), address(rewards));
        assertEq(address(e.asset()), address(usdg));
        assertEq(e.owner(), safe);
        assertEq(e.treasury(), safe);
        assertEq(e.forwardTo(), safe);
        assertEq(e.settleWindow(), 43200);
        assertEq(e.maxPerJob(), 5_000_000);
        assertEq(e.maxTotalHeld(), 500_000_000);
        assertEq(e.maxPerPayerPerEpoch(), 50_000_000);
        assertFalse(e.potPaysInAsset(), "ETH pot: forward goes to forwardTo for conversion");
    }

    function _refusesAWrongEip712Domain() internal {
        vm.setEnv("X402_ASSET_VERSION", "2");
        vm.expectRevert(bytes("X402_ASSET_NAME / X402_ASSET_VERSION do not match the asset's DOMAIN_SEPARATOR"));
        script.run();
        vm.setEnv("X402_ASSET_VERSION", "1");
    }

    function _refusesATokenWithoutEip3009() internal {
        PlainPermitToken plain = new PlainPermitToken();
        vm.setEnv("X402_ASSET", vm.toString(address(plain)));
        vm.setEnv("X402_ASSET_NAME", "Plain");
        vm.setEnv("X402_ASSET_VERSION", "1");
        vm.expectRevert(bytes("X402_ASSET does not answer EIP-3009 authorizationState"));
        script.run();
        vm.setEnv("X402_ASSET", vm.toString(address(usdg)));
        vm.setEnv("X402_ASSET_NAME", "Global Dollar");
    }

    function _mainnetGuards() internal {
        vm.chainId(4663);
        // A token deployed on "this" chain id, so its DOMAIN_SEPARATOR names 4663.
        usdg = new MockEIP3009Token("Global Dollar", "1", 6);
        vm.setEnv("X402_ASSET", vm.toString(address(usdg)));
        SparecycleX402Escrow e = script.run();
        assertEq(e.owner(), safe);

        address eoa = makeAddr("eoa");
        vm.setEnv("TREASURY", vm.toString(eoa));
        vm.expectRevert(bytes("mainnet: TREASURY must be the Safe multisig (a contract)"));
        script.run();
        vm.setEnv("TREASURY", vm.toString(safe));

        vm.setEnv("X402_FORWARD_TO", vm.toString(eoa));
        vm.expectRevert(bytes("mainnet: X402_FORWARD_TO must be a Safe-controlled contract"));
        script.run();
        vm.setEnv("X402_FORWARD_TO", vm.toString(safe));

        address otherSafe = address(new FakeSafe());
        vm.setEnv("ADMIN", vm.toString(otherSafe));
        vm.expectRevert(bytes("mainnet: ADMIN must be the reward contract's owner (the Safe)"));
        script.run();
    }

    function _missingCapIsAnError() internal {
        vm.setEnv("X402_MAX_PER_PAYER_PER_EPOCH", "");
        vm.expectRevert();
        script.run();
        vm.setEnv("X402_MAX_PER_PAYER_PER_EPOCH", "50000000");
    }
}

/// @notice An ERC-20 with an EIP-712 domain but no EIP-3009 (authorizationState is missing).
contract PlainPermitToken is MockERC20 {
    constructor() MockERC20("Plain", "PLN", 6) {}

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Plain"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }
}
