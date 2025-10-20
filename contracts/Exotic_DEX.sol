pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ExoticDexFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct Batch {
        uint256 id;
        bool open;
        uint256 priceSum;
        uint256 count;
    }
    Batch public currentBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, uint256 priceSum, uint256 count);
    event PriceSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedPrice);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 finalPrice);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error InvalidBatchState();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        cooldownSeconds = 60; // Default 1 minute cooldown
        currentBatch = Batch({id: 0, open: false, priceSum: 0, count: 0});
    }

    function transferOwnership(address newOwner) public onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) public onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) public onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldown) public onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSet(oldCooldown, newCooldown);
    }

    function pause() public onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() public onlyOwner whenNotPaused {
        if (currentBatch.open) revert InvalidBatchState();
        currentBatch.id++;
        currentBatch.open = true;
        currentBatch.priceSum = 0;
        currentBatch.count = 0;
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() public onlyOwner whenNotPaused {
        if (!currentBatch.open) revert BatchClosedOrNonExistent();
        currentBatch.open = false;
        emit BatchClosed(currentBatch.id, currentBatch.priceSum, currentBatch.count);
    }

    function submitEncryptedPrice(euint32 encryptedPrice) public onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!currentBatch.open) revert BatchClosedOrNonExistent();
        _initIfNeeded(encryptedPrice);
        lastSubmissionTime[msg.sender] = block.timestamp;
        currentBatch.priceSum = FHE.add(FHE.asEuint32(currentBatch.priceSum), encryptedPrice).toUint32();
        currentBatch.count++;
        emit PriceSubmitted(msg.sender, currentBatch.id, encryptedPrice);
    }

    function requestPriceDecryption() public whenNotPaused checkDecryptionCooldown {
        if (currentBatch.open || currentBatch.count == 0) revert InvalidBatchState();
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedTotalPrice = FHE.asEuint32(currentBatch.priceSum);
        euint32 encryptedCount = FHE.asEuint32(currentBatch.count);
        _initIfNeeded(encryptedTotalPrice);
        _initIfNeeded(encryptedCount);

        euint32 encryptedAvgPrice = FHE.div(encryptedTotalPrice, encryptedCount);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedAvgPrice);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatch.id, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatch.id, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        Batch memory batch = currentBatch; // Use memory version for consistency
        if (batch.id != decryptionContexts[requestId].batchId || batch.open || batch.count == 0) {
            revert InvalidBatchState(); // Batch state changed or invalid
        }

        euint32 encryptedTotalPrice = FHE.asEuint32(batch.priceSum);
        euint32 encryptedCount = FHE.asEuint32(batch.count);
        _initIfNeeded(encryptedTotalPrice);
        _initIfNeeded(encryptedCount);
        euint32 encryptedAvgPrice = FHE.div(encryptedTotalPrice, encryptedCount);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedAvgPrice);
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 finalPrice = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batch.id, finalPrice);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!FHE.isInitialized(x)) revert NotInitialized();
    }

    function _initIfNeeded(ebool x) internal {
        if (!FHE.isInitialized(x)) revert NotInitialized();
    }
}