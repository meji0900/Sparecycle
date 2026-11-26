// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DryRunDeployV2} from "../../script/DryRunDeployV2.s.sol";

/// @notice The dry-run deploy script runs end to end with local stand-ins and wires the three contracts together.
contract DryRunDeployV2Test is Test {
    function test_DryRunWiresEverything() public {
        DryRunDeployV2 s = new DryRunDeployV2();
        DryRunDeployV2.Deployed memory d = s.run();
        assertEq(d.payments.holderPool(), address(d.holderPool));
        assertEq(d.payments.burner(), address(d.burner));
        assertEq(address(d.burner.priceSource()), address(d.payments));
        assertEq(address(d.holderPool.payments()), address(d.payments));
        assertEq(d.payments.spareCapEthPerEpoch(), 0, "SPARE payments off by default");
    }
}
