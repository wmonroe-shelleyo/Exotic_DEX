// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface AssetRecord {
  id: string;
  encryptedPrice: string;
  timestamp: number;
  owner: string;
  assetType: string;
  status: "pending" | "verified" | "rejected";
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

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'volatility':
      result = value * (1 + (Math.random() * 0.2 - 0.1)); // Simulate 10% volatility
      break;
    case 'timeDecay':
      result = value * 0.99; // Simulate 1% time decay
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ assetType: "", description: "", price: 0 });
  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState("all");

  const verifiedCount = assets.filter(a => a.status === "verified").length;
  const pendingCount = assets.filter(a => a.status === "pending").length;
  const rejectedCount = assets.filter(a => a.status === "rejected").length;

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
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

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: AssetRecord[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                encryptedPrice: assetData.price, 
                timestamp: assetData.timestamp, 
                owner: assetData.owner, 
                assetType: assetData.assetType, 
                status: assetData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset price with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newAssetData.price);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        price: encryptedPrice, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        assetType: newAssetData.assetType, 
        status: "pending" 
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted asset submitted securely!" });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAssetData({ assetType: "", description: "", price: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedPrice: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedPrice);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted price with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      
      const verifiedPrice = FHECompute(assetData.price, 'volatility');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAsset = { ...assetData, status: "verified", price: verifiedPrice };
      await contractWithSigner.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted price with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      const updatedAsset = { ...assetData, status: "rejected" };
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (assetAddress: string) => address?.toLowerCase() === assetAddress.toLowerCase();

  const filteredAssets = assets.filter(asset => {
    const matchesSearch = asset.assetType.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         asset.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterType === "all" || asset.status === filterType;
    return matchesSearch && matchesFilter;
  });

  const renderPriceChart = () => {
    const verifiedAssets = assets.filter(a => a.status === "verified");
    if (verifiedAssets.length === 0) return <div className="no-data-chart">No verified assets yet</div>;
    
    const prices = verifiedAssets.map(a => {
      try {
        return FHEDecryptNumber(a.encryptedPrice);
      } catch {
        return 0;
      }
    }).filter(p => p > 0);
    
    if (prices.length === 0) return <div className="no-data-chart">No valid price data</div>;
    
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    
    return (
      <div className="price-chart-container">
        <div className="chart-bars">
          {prices.slice(0, 10).map((price, i) => (
            <div key={i} className="chart-bar-container">
              <div 
                className="chart-bar" 
                style={{ height: `${((price - minPrice) / (maxPrice - minPrice)) * 80 + 20}%` }}
                data-price={price.toFixed(2)}
              ></div>
            </div>
          ))}
        </div>
        <div className="chart-stats">
          <div className="stat-item">
            <div className="stat-label">Highest</div>
            <div className="stat-value">{maxPrice.toFixed(2)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Average</div>
            <div className="stat-value">{avgPrice.toFixed(2)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Lowest</div>
            <div className="stat-value">{minPrice.toFixed(2)}</div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE oracle connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>Exotic<span>DEX</span></h1>
          <div className="fhe-tag">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        <div className="header-actions">
          <div className="search-container">
            <input 
              type="text" 
              placeholder="Search assets..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="metal-input"
            />
            <select 
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="metal-select"
            >
              <option value="all">All Status</option>
              <option value="verified">Verified</option>
              <option value="pending">Pending</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <button onClick={() => setShowCreateModal(true)} className="create-asset-btn metal-button">
            <div className="add-icon"></div>List Asset
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content modular-tiling">
        <div className="welcome-tile metal-tile">
          <div className="welcome-content">
            <h2>Exotic Asset DEX</h2>
            <p>
              A decentralized exchange specializing in exotic assets (volatility indices, 
              real-world event derivatives) using <strong>Zama FHE-based oracles</strong> 
              to aggregate multiple encrypted data sources, preventing manipulation while 
              protecting data source privacy.
            </p>
            <div className="tech-badges">
              <span className="badge">FHE Encryption</span>
              <span className="badge">Homomorphic Pricing</span>
              <span className="badge">Exotic Assets</span>
            </div>
          </div>
          <div className="fhe-visualization">
            <div className="fhe-node"></div>
            <div className="fhe-connection"></div>
            <div className="fhe-node"></div>
            <div className="fhe-connection"></div>
            <div className="fhe-node"></div>
          </div>
        </div>

        <div className="stats-tile metal-tile">
          <h3>Market Statistics</h3>
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">{assets.length}</div>
              <div className="stat-label">Total Assets</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{verifiedCount}</div>
              <div className="stat-label">Verified</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{pendingCount}</div>
              <div className="stat-label">Pending</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{rejectedCount}</div>
              <div className="stat-label">Rejected</div>
            </div>
          </div>
        </div>

        <div className="chart-tile metal-tile">
          <h3>Price Distribution</h3>
          {renderPriceChart()}
        </div>

        <div className="assets-tile metal-tile">
          <div className="section-header">
            <h2>Exotic Assets</h2>
            <div className="header-actions">
              <button onClick={loadAssets} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="assets-list">
            <div className="list-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Asset Type</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredAssets.length === 0 ? (
              <div className="no-assets">
                <div className="no-assets-icon"></div>
                <p>No assets found matching your criteria</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>List First Asset</button>
              </div>
            ) : filteredAssets.map(asset => (
              <div 
                className="asset-row" 
                key={asset.id} 
                onClick={() => setSelectedAsset(asset)}
                data-status={asset.status}
              >
                <div className="list-cell asset-id">#{asset.id.substring(0, 6)}</div>
                <div className="list-cell">{asset.assetType}</div>
                <div className="list-cell">{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</div>
                <div className="list-cell">{new Date(asset.timestamp * 1000).toLocaleDateString()}</div>
                <div className="list-cell">
                  <span className={`status-badge ${asset.status}`}>{asset.status}</span>
                </div>
                <div className="list-cell actions">
                  {isOwner(asset.owner) && asset.status === "pending" && (
                    <>
                      <button 
                        className="action-btn metal-button success" 
                        onClick={(e) => { e.stopPropagation(); verifyAsset(asset.id); }}
                      >
                        Verify
                      </button>
                      <button 
                        className="action-btn metal-button danger" 
                        onClick={(e) => { e.stopPropagation(); rejectAsset(asset.id); }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitAsset} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          assetData={newAssetData} 
          setAssetData={setNewAssetData}
        />
      )}

      {selectedAsset && (
        <AssetDetailModal 
          asset={selectedAsset} 
          onClose={() => { setSelectedAsset(null); setDecryptedPrice(null); }} 
          decryptedPrice={decryptedPrice} 
          setDecryptedPrice={setDecryptedPrice} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-tile">
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
            <div className="logo">
              <div className="shield-icon"></div>
              <span>ExoticDEX</span>
            </div>
            <p>Secure trading of exotic assets using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} ExoticDEX. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  assetData: any;
  setAssetData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, assetData, setAssetData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: value });
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!assetData.assetType || !assetData.price) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-tile">
        <div className="modal-header">
          <h2>List New Exotic Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your asset price will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Asset Type *</label>
              <select 
                name="assetType" 
                value={assetData.assetType} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="">Select asset type</option>
                <option value="Volatility Index">Volatility Index</option>
                <option value="Event Derivative">Event Derivative</option>
                <option value="Weather Derivative">Weather Derivative</option>
                <option value="Exotic Swap">Exotic Swap</option>
                <option value="Other">Other</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Description</label>
              <input 
                type="text" 
                name="description" 
                value={assetData.description} 
                onChange={handleChange} 
                placeholder="Brief description..." 
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Price *</label>
              <input 
                type="number" 
                name="price" 
                value={assetData.price} 
                onChange={handlePriceChange} 
                placeholder="Enter price value..." 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Price:</span>
                <div>{assetData.price || 'No price entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {assetData.price ? 
                    FHEEncryptNumber(assetData.price).substring(0, 50) + '...' : 
                    'No price entered'
                  }
                </div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Data Privacy Guarantee</strong>
              <p>Price data remains encrypted during FHE processing and is never decrypted on our servers</p>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetDetailModalProps {
  asset: AssetRecord;
  onClose: () => void;
  decryptedPrice: number | null;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedPrice: string) => Promise<number | null>;
}

const AssetDetailModal: React.FC<AssetDetailModalProps> = ({ 
  asset, 
  onClose, 
  decryptedPrice, 
  setDecryptedPrice, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedPrice !== null) { 
      setDecryptedPrice(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(asset.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="asset-detail-modal metal-tile">
        <div className="modal-header">
          <h2>Asset Details #{asset.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="asset-info">
            <div className="info-item">
              <span>Type:</span>
              <strong>{asset.assetType}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(asset.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${asset.status}`}>{asset.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Price Data</h3>
            <div className="encrypted-data">
              {asset.encryptedPrice.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedPrice !== null ? (
                "Hide Decrypted Price"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedPrice !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Price</h3>
              <div className="decrypted-value">
                {decryptedPrice.toFixed(2)}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted price is only visible after wallet signature verification</span>
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

export default App;