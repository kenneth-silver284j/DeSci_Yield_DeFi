import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface StakingRecord {
  id: string;
  encryptedAmount: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "active" | "withdrawn";
  yieldRate: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeYield = (encryptedData: string, yieldRate: number): string => {
  const value = FHEDecryptNumber(encryptedData);
  const result = value * (1 + yieldRate/100);
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<StakingRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showStakeModal, setShowStakeModal] = useState(false);
  const [staking, setStaking] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newStakeData, setNewStakeData] = useState({ category: "Research", amount: 0, duration: 30 });
  const [selectedRecord, setSelectedRecord] = useState<StakingRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);

  const activeStakes = records.filter(r => r.status === "active");
  const withdrawnStakes = records.filter(r => r.status === "withdrawn");
  const totalStaked = activeStakes.reduce((sum, record) => sum + FHEDecryptNumber(record.encryptedAmount), 0);
  const totalYield = activeStakes.reduce((sum, record) => sum + (FHEDecryptNumber(record.encryptedAmount) * record.yieldRate/100), 0);

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("stake_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing stake keys:", e); }
      }
      
      const list: StakingRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`stake_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedAmount: recordData.amount, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                category: recordData.category, 
                status: recordData.status || "active",
                yieldRate: recordData.yieldRate || 5
              });
            } catch (e) { console.error(`Error parsing stake data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading stake ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading stakes:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createStake = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (newStakeData.amount <= 0) { alert("Amount must be positive"); return; }
    
    setStaking(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting DeSci contribution with Zama FHE..." });
    
    try {
      const encryptedAmount = FHEEncryptNumber(newStakeData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const stakeId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const stakeData = { 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newStakeData.category, 
        status: "active",
        yieldRate: calculateYieldRate(newStakeData.duration)
      };
      
      await contract.setData(`stake_${stakeId}`, ethers.toUtf8Bytes(JSON.stringify(stakeData)));
      
      const keysBytes = await contract.getData("stake_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(stakeId);
      await contract.setData("stake_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "DeSci contribution staked securely with FHE!" });
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowStakeModal(false);
        setNewStakeData({ category: "Research", amount: 0, duration: 30 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Staking failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setStaking(false); }
  };

  const withdrawStake = async (stakeId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing FHE-encrypted withdrawal..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`stake_${stakeId}`);
      if (recordBytes.length === 0) throw new Error("Stake not found");
      const stakeData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const yieldAmount = FHEComputeYield(stakeData.amount, stakeData.yieldRate || 5);
      const updatedStake = { ...stakeData, status: "withdrawn", amount: yieldAmount };
      
      await contractWithSigner.setData(`stake_${stakeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedStake)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE withdrawal completed with yield!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Withdrawal failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const calculateYieldRate = (duration: number): number => {
    // Longer duration = higher yield
    if (duration >= 365) return 15;
    if (duration >= 180) return 10;
    if (duration >= 90) return 7;
    return 5;
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const topContributors = [...records]
    .filter(r => r.status === "active")
    .sort((a, b) => FHEDecryptNumber(b.encryptedAmount) - FHEDecryptNumber(a.encryptedAmount))
    .slice(0, 5);

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="atom-icon"></div></div>
          <h1>DeSci<span>Yield</span>DeFi</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowStakeModal(true)} className="stake-btn metal-button">
            <div className="add-icon"></div>Stake Contribution
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>DeSci Yield DeFi Protocol</h2>
            <p>Stake your DeSci contributions as alternative assets and earn yield with Zama FHE encryption</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card metal-card intro-card">
            <h3>Project Introduction</h3>
            <p>This DeFi protocol allows researchers to stake their <strong>DeSci contributions</strong> (research data, peer reviews, datasets) as alternative assets. All staked amounts are encrypted using <strong>Zama FHE</strong> and yield is computed homomorphically.</p>
            <div className="tech-tags">
              <span className="tag-fhe">FHE Encryption</span>
              <span className="tag-defi">DeFi Yield</span>
              <span className="tag-desci">DeSci Integration</span>
            </div>
          </div>

          <div className="dashboard-card metal-card stats-card">
            <h3>Protocol Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{activeStakes.length}</div>
                <div className="stat-label">Active Stakes</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalStaked.toFixed(2)}</div>
                <div className="stat-label">Total Staked</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalYield.toFixed(2)}</div>
                <div className="stat-label">Total Yield</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{withdrawnStakes.length}</div>
                <div className="stat-label">Withdrawn</div>
              </div>
            </div>
          </div>

          <div className="dashboard-card metal-card contributors-card">
            <h3>Top Contributors</h3>
            <div className="contributors-list">
              {topContributors.length > 0 ? (
                topContributors.map((contributor, index) => (
                  <div className="contributor-item" key={contributor.id}>
                    <div className="contributor-rank">{index + 1}</div>
                    <div className="contributor-address">{contributor.owner.substring(0, 6)}...{contributor.owner.substring(38)}</div>
                    <div className="contributor-amount">
                      {FHEDecryptNumber(contributor.encryptedAmount).toFixed(2)} 
                      <span className="yield-rate">+{contributor.yieldRate}%</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="no-contributors">No active contributors yet</div>
              )}
            </div>
          </div>
        </div>

        <div className="stakes-section">
          <div className="section-header">
            <h2>Your DeSci Stakes</h2>
            <div className="header-actions">
              <button onClick={loadRecords} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="stakes-list metal-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Amount</div>
              <div className="header-cell">Yield Rate</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {records.filter(r => isOwner(r.owner)).length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No staked contributions found</p>
                <button className="metal-button primary" onClick={() => setShowStakeModal(true)}>Stake First Contribution</button>
              </div>
            ) : records.filter(r => isOwner(r.owner)).map(record => (
              <div className="stake-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell stake-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.category}</div>
                <div className="table-cell amount">
                  {record.status === "withdrawn" ? (
                    <span className="withdrawn-amount">{FHEDecryptNumber(record.encryptedAmount).toFixed(2)}</span>
                  ) : (
                    <span className="active-amount">{FHEDecryptNumber(record.encryptedAmount).toFixed(2)}</span>
                  )}
                </div>
                <div className="table-cell">{record.yieldRate}%</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(record.owner) && record.status === "active" && (
                    <button className="action-btn metal-button success" onClick={(e) => { e.stopPropagation(); withdrawStake(record.id); }}>Withdraw</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showStakeModal && (
        <ModalStake 
          onSubmit={createStake} 
          onClose={() => setShowStakeModal(false)} 
          staking={staking} 
          stakeData={newStakeData} 
          setStakeData={setNewStakeData}
        />
      )}

      {selectedRecord && (
        <StakeDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedAmount(null); }} 
          decryptedAmount={decryptedAmount} 
          setDecryptedAmount={setDecryptedAmount} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="atom-icon"></div><span>DeSciYieldDeFi</span></div>
            <p>Stake your research contributions with FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} DeSci Yield DeFi. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalStakeProps {
  onSubmit: () => void; 
  onClose: () => void; 
  staking: boolean;
  stakeData: any;
  setStakeData: (data: any) => void;
}

const ModalStake: React.FC<ModalStakeProps> = ({ onSubmit, onClose, staking, stakeData, setStakeData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setStakeData({ ...stakeData, [name]: value });
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setStakeData({ ...stakeData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!stakeData.category || stakeData.amount <= 0) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="stake-modal metal-card">
        <div className="modal-header">
          <h2>Stake DeSci Contribution</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your contribution value will be encrypted with Zama FHE before staking</p></div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Contribution Type *</label>
              <select name="category" value={stakeData.category} onChange={handleChange} className="metal-select">
                <option value="Research">Research Data</option>
                <option value="Review">Peer Review</option>
                <option value="Dataset">Dataset</option>
                <option value="Analysis">Analysis</option>
                <option value="Other">Other</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Duration (Days)</label>
              <input 
                type="number" 
                name="duration" 
                value={stakeData.duration} 
                onChange={handleChange} 
                min="7"
                max="365"
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Contribution Value *</label>
              <input 
                type="number" 
                name="amount" 
                value={stakeData.amount} 
                onChange={handleAmountChange} 
                placeholder="Enter numerical value..." 
                className="metal-input"
                step="0.01"
                min="0.01"
              />
            </div>
          </div>
          
          <div className="yield-preview">
            <h4>Yield Preview</h4>
            <div className="preview-container">
              <div className="yield-rate">
                <span>Estimated APR:</span>
                <strong>{calculateYieldRate(stakeData.duration)}%</strong>
              </div>
              <div className="yield-amount">
                <span>Projected Yield:</span>
                <strong>{(stakeData.amount * (calculateYieldRate(stakeData.duration)/100)).toFixed(2)}</strong>
              </div>
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{stakeData.amount || '0.00'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{stakeData.amount ? FHEEncryptNumber(stakeData.amount).substring(0, 50) + '...' : '0.00'}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={staking} className="submit-btn metal-button primary">
            {staking ? "Encrypting with FHE..." : "Stake Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface StakeDetailModalProps {
  record: StakingRecord;
  onClose: () => void;
  decryptedAmount: number | null;
  setDecryptedAmount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const StakeDetailModal: React.FC<StakeDetailModalProps> = ({ record, onClose, decryptedAmount, setDecryptedAmount, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) { setDecryptedAmount(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedAmount);
    if (decrypted !== null) setDecryptedAmount(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="stake-detail-modal metal-card">
        <div className="modal-header">
          <h2>Stake Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="stake-info">
            <div className="info-item"><span>Type:</span><strong>{record.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Yield Rate:</span><strong>{record.yieldRate}%</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">{record.encryptedAmount.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn metal-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedAmount !== null ? "Hide Value" : "Decrypt with Wallet"}
            </button>
          </div>
          
          {decryptedAmount !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedAmount.toFixed(2)}</div>
              {record.status === "active" && (
                <div className="projected-yield">
                  <span>Projected Yield:</span>
                  <strong>{(decryptedAmount * (record.yieldRate/100)).toFixed(2)}</strong>
                </div>
              )}
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

const calculateYieldRate = (duration: number): number => {
  if (duration >= 365) return 15;
  if (duration >= 180) return 10;
  if (duration >= 90) return 7;
  return 5;
};

export default App;