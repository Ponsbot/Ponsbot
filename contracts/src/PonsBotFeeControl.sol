// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared emergency and operational control for every automated fee vault.
/// The guardian may stop processing immediately. Only the admin may resume it.
contract PonsBotFeeControl {
    address public admin;
    address public pendingAdmin;
    address public pauseGuardian;
    address public keeper;
    address public quoteAuthorizer;
    address public executionAdapter;
    bool public processingEnabled;

    event ProcessingStateChanged(bool enabled);
    event PauseGuardianUpdated(address indexed previousGuardian, address indexed nextGuardian);
    event AdminTransferProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed nextAdmin);
    event KeeperUpdated(address indexed previousKeeper, address indexed nextKeeper);
    event QuoteAuthorizerUpdated(address indexed previousAuthorizer, address indexed nextAuthorizer);
    event ExecutionAdapterConfigured(address indexed adapter);
    event ExecutionAdapterUpdated(address indexed previousAdapter, address indexed nextAdapter);

    error Unauthorized();
    error InvalidConfiguration();

    constructor(address admin_, address pauseGuardian_, address keeper_, address quoteAuthorizer_) {
        if (
            admin_ == address(0) || pauseGuardian_ == address(0) || keeper_ == address(0)
                || quoteAuthorizer_ == address(0) || quoteAuthorizer_ == keeper_ || quoteAuthorizer_ == admin_
                || quoteAuthorizer_ == pauseGuardian_ || quoteAuthorizer_.code.length != 0
        ) {
            revert InvalidConfiguration();
        }
        admin = admin_;
        pauseGuardian = pauseGuardian_;
        keeper = keeper_;
        quoteAuthorizer = quoteAuthorizer_;
        processingEnabled = false;
    }

    function pauseProcessing() external {
        if (msg.sender != admin && msg.sender != pauseGuardian) revert Unauthorized();
        processingEnabled = false;
        emit ProcessingStateChanged(false);
    }

    function enableProcessing() external {
        if (msg.sender != admin) revert Unauthorized();
        if (
            executionAdapter == address(0) || executionAdapter.code.length == 0 || quoteAuthorizer == address(0)
                || quoteAuthorizer == keeper
        ) revert InvalidConfiguration();
        processingEnabled = true;
        emit ProcessingStateChanged(true);
    }

    function setPauseGuardian(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == address(0) || next == quoteAuthorizer || next == admin || next == keeper || next == pendingAdmin) {
            revert InvalidConfiguration();
        }
        emit PauseGuardianUpdated(pauseGuardian, next);
        pauseGuardian = next;
    }

    function setKeeper(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == address(0) || next == quoteAuthorizer || next == admin || next == pauseGuardian || next == pendingAdmin) {
            revert InvalidConfiguration();
        }
        emit KeeperUpdated(keeper, next);
        keeper = next;
    }

    function setQuoteAuthorizer(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (
            processingEnabled || next == address(0) || next == keeper || next == admin || next == pauseGuardian
                || next == pendingAdmin
                || next.code.length != 0
        ) revert InvalidConfiguration();
        emit QuoteAuthorizerUpdated(quoteAuthorizer, next);
        quoteAuthorizer = next;
    }

    function setExecutionAdapter(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (processingEnabled) revert InvalidConfiguration();
        if (next == address(0) || next.code.length == 0) revert InvalidConfiguration();
        address previous = executionAdapter;
        executionAdapter = next;
        emit ExecutionAdapterUpdated(previous, next);
    }

    function proposeAdmin(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == address(0) || next == quoteAuthorizer || next == keeper || next == pauseGuardian) {
            revert InvalidConfiguration();
        }
        pendingAdmin = next;
        emit AdminTransferProposed(admin, next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        if (msg.sender == quoteAuthorizer || msg.sender == keeper || msg.sender == pauseGuardian) {
            revert InvalidConfiguration();
        }
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }
}
