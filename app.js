document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const workspace = document.getElementById('workspace');
    const resultArea = document.getElementById('result-area');
    
    const fileListContainer = document.getElementById('file-list');
    const totalOriginalSizeDisplay = document.getElementById('total-original-size');
    
    const compressBtn = document.getElementById('compress-btn');
    const btnText = compressBtn.querySelector('.btn-text');
    const spinner = compressBtn.querySelector('.spinner');
    
    const newSizeDisplay = document.getElementById('new-size');
    const spaceSavedDisplay = document.getElementById('space-saved');
    const downloadBtn = document.getElementById('download-btn');

    let selectedFiles = [];
    let totalOriginalSize = 0;

    // --- Event Listeners ---
    
    // Fix: Allow clicking anywhere in the drop zone OR the specific button
    dropZone.addEventListener('click', () => fileInput.click());
    
    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevents double-firing the click event
        fileInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
        // Fix: Reset input value so the user can upload the exact same file again if needed
        e.target.value = ''; 
    });

    compressBtn.addEventListener('click', processBatchLossless);

    // --- Core Functions ---
    function handleFiles(files) {
        if (!files || files.length === 0) return;

        let newFiles = Array.from(files);
        if (newFiles.length > 10) {
            alert('You can only upload up to 10 files at a time.');
            newFiles = newFiles.slice(0, 10);
        }

        selectedFiles = newFiles;
        totalOriginalSize = 0;
        fileListContainer.innerHTML = '';

        selectedFiles.forEach(file => {
            totalOriginalSize += file.size;
            
            let typeLabel = 'DOC';
            if (file.type.startsWith('image/')) typeLabel = 'IMG';
            if (file.type.startsWith('video/')) typeLabel = 'VID';

            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            fileItem.innerHTML = `
                <div class="file-item-info">
                    <span class="file-item-name" title="${file.name}">${file.name}</span>
                    <span class="file-item-type">${typeLabel}</span>
                </div>
                <span class="badge">${formatBytes(file.size)}</span>
            `;
            fileListContainer.appendChild(fileItem);
        });

        totalOriginalSizeDisplay.textContent = formatBytes(totalOriginalSize);
        workspace.classList.remove('hidden');
        resultArea.classList.add('hidden');
    }

    async function processBatchLossless() {
        if (selectedFiles.length === 0) return;

        btnText.textContent = 'Packing Losslessly...';
        spinner.classList.remove('hidden');
        compressBtn.disabled = true;

        try {
            const zip = new JSZip();

            for (const file of selectedFiles) {
                let processedBlob = file;
                let finalName = file.name;
                const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

                if (file.type.match(/image\/(jpeg|png|webp)/)) {
                    processedBlob = await optimizeImageLossless(file);
                    if (processedBlob !== file) {
                        finalName = `${baseName}.webp`;
                    }
                }

                zip.file(finalName, processedBlob);
            }

            const zipBlob = await zip.generateAsync({ 
                type: 'blob',
                compression: "DEFLATE",
                compressionOptions: { level: 9 }
            });
            
            handleBatchResult(zipBlob);

        } catch (error) {
            console.error("Compression Error:", error);
            alert("An error occurred while processing your files. Please try again.");
        } finally {
            // Fix: Ensure the button always resets even if an error occurs
            btnText.textContent = 'Pack Losslessly';
            spinner.classList.add('hidden');
            compressBtn.disabled = false;
        }
    }

    // --- Lossless Image Optimization ---
    function optimizeImageLossless(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const img = new Image();
                
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    
                    canvas.width = img.width;
                    canvas.height = img.height;

                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    canvas.toBlob((blob) => {
                        if (blob && blob.size < file.size) {
                            resolve(blob);
                        } else {
                            resolve(file);
                        }
                    }, 'image/webp', 1.0);
                };
                
                // Fix: If the image is corrupted, safely skip it instead of freezing
                img.onerror = () => resolve(file); 
                img.src = e.target.result;
            };
            
            // Fix: If the file reader fails, safely skip it
            reader.onerror = () => resolve(file);
            reader.readAsDataURL(file);
        });
    }

    // --- Accurate Math Result Handling ---
    function handleBatchResult(zipBlob) {
        let savings = ((totalOriginalSize - zipBlob.size) / totalOriginalSize) * 100;
        if (savings < 0) savings = 0; 

        newSizeDisplay.textContent = formatBytes(zipBlob.size);
        spaceSavedDisplay.textContent = `${savings.toFixed(1)}%`;

        const objectUrl = URL.createObjectURL(zipBlob);
        downloadBtn.href = objectUrl;

        resultArea.classList.remove('hidden');
        
        setTimeout(() => {
            resultArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
});
// ==========================================================================
    // BUY ME A COFFEE / CRYPTO OVERLAY POPUP DIALOG LOGIC
    // ==========================================================================

    // Target UI Node Addresses Configuration Map
    const cryptoConfig = {
        sol: 'GSaQYHN81uBhadwha11LaaD4j4GXBBQMAHE2ZP85kGeW',
        btc: 'bc1pqngtqtrq9jkvvk3g85lzamnrnayn7w86wg4xjd3xwj843694vzsqv8g92s',
        eth: '0xa59Ee32DA6434443cc8EF11BeeFD4d9adf559165'
    };

    const bmcTrigger = document.getElementById('bmc-trigger');
    const bmcOverlay = document.getElementById('bmc-modal-overlay');
    const bmcClose = document.getElementById('bmc-close');
    const bmcTabs = document.querySelectorAll('.bmc-tab-btn');
    const bmcAddressInput = document.getElementById('bmc-address-text');
    const bmcCopyBtn = document.getElementById('bmc-copy-btn');
    const bmcQrContainer = document.getElementById('bmc-qrcode-container');

    let qrEngine = null;
    let currentCrypto = 'sol';

    // Toggle Modal Window Display States
    function openBmcModal() {
        bmcOverlay.classList.remove('bmc-hidden');
        switchCryptoNetwork(currentCrypto);
    }

    function closeBmcModal() {
        bmcOverlay.classList.add('bmc-hidden');
    }

    // Process Active Target Content Switching & QR Calculations
    function switchCryptoNetwork(ticker) {
        currentCrypto = ticker;
        const address = cryptoConfig[ticker];
        bmcAddressInput.value = address;
        
        // Reset state variables on text copier interface elements
        bmcCopyBtn.textContent = 'Copy';
        bmcCopyBtn.classList.remove('bmc-copied');

        // Clear previous visual node elements before instantiation
        if (bmcQrContainer) {
            bmcQrContainer.innerHTML = '';
        }

        // Dynamically compute new canvas payload parameters
        qrEngine = new QRCode(bmcQrContainer, {
            text: address,
            width: 156,
            height: 156,
            colorDark: '#09090b',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    // Attach Event Listeners to Target Elements
    if (bmcTrigger) bmcTrigger.addEventListener('click', openBmcModal);
    if (bmcClose) bmcClose.addEventListener('click', closeBmcModal);

    // Prevent modal close when clicking inside the window content area
    if (bmcOverlay) {
        bmcOverlay.addEventListener('click', (e) => {
            if (e.target === bmcOverlay) closeBmcModal();
        });
    }

    if (bmcTabs && bmcTabs.length > 0) {
        bmcTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                bmcTabs.forEach(t => t.classList.remove('bmc-active'));
                tab.classList.add('bmc-active');
                switchCryptoNetwork(tab.getAttribute('data-crypto'));
            });
        });
    }

    // Handle Client-Side Clipboard Actions
    if (bmcCopyBtn) {
        bmcCopyBtn.addEventListener('click', async () => {
            const payloadText = bmcAddressInput.value;
            if (!payloadText || payloadText.startsWith('Loading')) return;

            try {
                await navigator.clipboard.writeText(payloadText);
                bmcCopyBtn.textContent = 'Copied!';
                bmcCopyBtn.classList.add('bmc-copied');
                
                setTimeout(() => {
                    bmcCopyBtn.textContent = 'Copy';
                    bmcCopyBtn.classList.remove('bmc-copied');
                }, 2000);
            } catch (err) {
                console.error('Could not copy wallet text: ', err);
                bmcAddressInput.select();
                document.execCommand('copy');
            }
        });
    }