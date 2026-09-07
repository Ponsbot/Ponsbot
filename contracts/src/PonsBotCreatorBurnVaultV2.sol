// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PonsBotCreatorBurnVault.sol";

/// @notice Deterministic creator layer used by new launches. The primary vault
/// is pre-bound to this contract's predicted address, and the owner's chosen
/// percentage is installed atomically with layer deployment.
contract PonsBotCreatorBurnVaultV2 is PonsBotCreatorBurnVault {
    constructor(address primary, address owner_, address executor_, address holderRegistry_, uint16 initialBps)
        PonsBotCreatorBurnVault(primary, owner_, executor_, holderRegistry_)
    {
        if (initialBps > 10_000) revert InvalidConfiguration();
        selfBurnBps = initialBps;
        if (initialBps != 0) {
            configurationNonce = 1;
            emit ConfigurationChanged(owner_, initialBps, 1);
        }
    }
}
