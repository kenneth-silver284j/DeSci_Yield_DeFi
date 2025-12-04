pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DeSciYieldDeFiFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error DecryptionFailed();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool open;
    }
    Batch public currentBatch;

    struct Contribution {
        euint32 encryptedScore;
        ebool encryptedValid;
    }
    mapping(uint256 => mapping(address => Contribution)) public contributions;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ContributionSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedScore, bytes32 encryptedValid);
    event YieldRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event YieldCalculated(uint256 indexed requestId, uint256 batchId, uint256 totalScore, uint256 totalValidContributions);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60;
        currentBatch = Batch({id: 0, open: false});
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        emit CooldownSecondsChanged(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatch.open) revert InvalidParameter();
        currentBatch = Batch({id: currentBatch.id + 1, open: true});
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.open) revert BatchClosed();
        currentBatch.open = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitContribution(
        euint32 encryptedScore,
        ebool encryptedValid
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!currentBatch.open) revert BatchClosed();

        _initIfNeeded(encryptedScore);
        _initIfNeeded(encryptedValid);

        lastSubmissionTime[msg.sender] = block.timestamp;
        contributions[currentBatch.id][msg.sender] = Contribution({
            encryptedScore: encryptedScore,
            encryptedValid: encryptedValid
        });
        emit ContributionSubmitted(
            msg.sender,
            currentBatch.id,
            encryptedScore.toBytes32(),
            encryptedValid.toBytes32()
        );
    }

    function requestYieldCalculation() external onlyOwner whenNotPaused {
        if (currentBatch.open) revert BatchNotClosed();
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedTotalScore = FHE.asEuint32(0);
        euint32 encryptedTotalValidContributions = FHE.asEuint32(0);
        uint256 count = 0;

        address provider = address(uint160(currentBatch.id)); // Dummy provider for iteration
        // In a real scenario, iterate through all providers who submitted to this batch
        // For this example, we'll assume one provider for simplicity
        // if (_isProvider(provider) && contributions[currentBatch.id][provider].encryptedScore.isInitialized()) {
            encryptedTotalScore = contributions[currentBatch.id][provider].encryptedScore.add(
                encryptedTotalScore
            );
            ebool isValid = contributions[currentBatch.id][provider].encryptedValid;
            encryptedTotalValidContributions = encryptedTotalValidContributions.add(
                isValid.select(FHE.asEuint32(1), FHE.asEuint32(0))
            );
            count++;
        // }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedTotalScore.toBytes32();
        cts[1] = encryptedTotalValidContributions.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatch.id,
            stateHash: stateHash,
            processed: false
        });

        emit YieldRequested(requestId, currentBatch.id, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        euint32 encryptedTotalScore = FHE.asEuint32(0);
        euint32 encryptedTotalValidContributions = FHE.asEuint32(0);
        address provider = address(uint160(decryptionContexts[requestId].batchId)); // Dummy provider
        // if (_isProvider(provider) && contributions[decryptionContexts[requestId].batchId][provider].encryptedScore.isInitialized()) {
            encryptedTotalScore = contributions[decryptionContexts[requestId].batchId][provider].encryptedScore.add(
                encryptedTotalScore
            );
            ebool isValid = contributions[decryptionContexts[requestId].batchId][provider].encryptedValid;
            encryptedTotalValidContributions = encryptedTotalValidContributions.add(
                isValid.select(FHE.asEuint32(1), FHE.asEuint32(0))
            );
        // }

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = encryptedTotalScore.toBytes32();
        currentCts[1] = encryptedTotalValidContributions.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            uint256 totalScore = abi.decode(cleartexts, (uint256));
            uint256 totalValidContributions = abi.decode(cleartexts[32:], (uint256));

            decryptionContexts[requestId].processed = true;
            emit YieldCalculated(requestId, decryptionContexts[requestId].batchId, totalScore, totalValidContributions);
        } catch {
            revert DecryptionFailed();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) {
            val = FHE.asEuint32(0);
        }
    }

    function _initIfNeeded(ebool val) internal {
        if (!val.isInitialized()) {
            val = FHE.asEbool(false);
        }
    }
}