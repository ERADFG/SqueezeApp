document.addEventListener('DOMContentLoaded', () => {
    // --- Navigation Panel Declarations ---
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const menuItems = document.querySelectorAll('.menu-item');
    const appPanels = document.querySelectorAll('.app-panel');
    const appDescription = document.getElementById('app-description');

    // --- Compressor Declarations ---
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const workspace = document.getElementById('workspace');
    const resultArea = document.getElementById('result-area');
    const fileListContainer = document.getElementById('file-list');
    const totalOriginalSizeDisplay = document.getElementById('total-original-size');
    const compressBtn = document.getElementById('compress-btn');
    const newSizeDisplay = document.getElementById('new-size');
    const spaceSavedDisplay = document.getElementById('space-saved');
    const downloadBtn = document.getElementById('download-btn');

    // --- Converter Declarations ---
    const converterDropZone = document.getElementById('converter-drop-zone');
    const converterInput = document.getElementById('converter-input');
    const converterBrowseBtn = document.getElementById('converter-browse-btn');
    const converterFileStatus = document.getElementById('converter-file-status');
    const convertTarget = document.getElementById('convert-target');
    const runConvertBtn = document.getElementById('run-convert-btn');
    const converterDownloadLink = document.getElementById('converter-download-link');

    let selectedFiles = [];
    let totalOriginalSize = 0;
    let activeConverterFile = null;

    // ==========================================================================
    // SIDEBAR TOGGLE AND MENU MANAGEMENT
    // ==========================================================================
    function toggleMenu() {
        menuToggle.classList.toggle('open');
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('open');
    }

    if (menuToggle) menuToggle.addEventListener('click', toggleMenu);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', toggleMenu);

    menuItems.forEach(item => {
        item.addEventListener('click', () => {
            menuItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const targetPanelId = item.dataset.target;
            appPanels.forEach(panel => panel.classList.add('hidden'));
            document.getElementById(targetPanelId).classList.remove('hidden');

            if (targetPanelId === 'panel-squeezer') {
                appDescription.textContent = "Pure lossless compression. Zero quality drop.";
            } else if (targetPanelId === 'panel-converter') {
                appDescription.textContent = "On-device compilation engine. Absolute client data security.";
            }
            toggleMenu();
        });
    });

    // ==========================================================================
    // SMART COMPRESSOR LOGIC BLOCK
    // ==========================================================================
    if(dropZone) dropZone.addEventListener('click', () => fileInput.click());
    if(browseBtn) browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    if(dropZone) {
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
    }
    if(fileInput) fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); });

    function handleFiles(files) {
        if (!files.length) return;
        selectedFiles = Array.from(files).slice(0, 10);
        totalOriginalSize = 0;
        fileListContainer.innerHTML = '';

        selectedFiles.forEach(file => {
            totalOriginalSize += file.size;
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justify = 'space-between';
            row.style.padding = '6px 0';
            row.innerHTML = `<span style="color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:70%;">${file.name}</span><b>${formatBytes(file.size)}</b>`;
            fileListContainer.appendChild(row);
        });

        totalOriginalSizeDisplay.textContent = formatBytes(totalOriginalSize);
        workspace.classList.remove('hidden');
        resultArea.classList.add('hidden');
    }

    if(compressBtn) {
        compressBtn.addEventListener('click', async () => {
            try {
                const zip = new JSZip();
                selectedFiles.forEach(file => zip.file(file.name, file));
                const blob = await zip.generateAsync({ type: 'blob', compression: "DEFLATE", compressionOptions: { level: 9 } });
                
                newSizeDisplay.textContent = formatBytes(blob.size);
                spaceSavedDisplay.textContent = `${Math.max(0, ((totalOriginalSize - blob.size) / totalOriginalSize) * 100).toFixed(1)}%`;
                downloadBtn.href = URL.createObjectURL(blob);
                resultArea.classList.remove('hidden');
            } catch (err) { console.error(err); }
        });
    }

    // ==========================================================================
    // FIXED UNIVERSAL CONVERTER LOGIC (NO MORE BROKEN PDFs)
    // ==========================================================================
    if(converterDropZone) converterDropZone.addEventListener('click', () => converterInput.click());
    if(converterBrowseBtn) converterBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); converterInput.click(); });
    if(converterDropZone) {
        converterDropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
        converterDropZone.addEventListener('drop', (e) => { e.preventDefault(); if(e.dataTransfer.files.length) handleConverterSetup(e.dataTransfer.files[0]); });
    }
    if(converterInput) converterInput.addEventListener('change', (e) => { if(e.target.files.length) handleConverterSetup(e.target.files[0]); });

    function handleConverterSetup(file) {
        activeConverterFile = file;
        converterFileStatus.textContent = `Target Loaded: ${file.name}`;
        converterDownloadLink.classList.add('hidden');
    }

    if(runConvertBtn) {
        runConvertBtn.addEventListener('click', () => {
            if (!activeConverterFile) return;
            const format = convertTarget.value;
            const reader = new FileReader();

            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const baseName = activeConverterFile.name.substring(0, activeConverterFile.name.lastIndexOf('.')) || activeConverterFile.name;

                    // FIXED: Using real jsPDF framework variables instead of basic text strings
                    if (format === 'pdf') {
                        const { jsPDF } = window.jspdf;
                        
                        // Calculate orientation based on image dimensions
                        const orientation = img.width > img.height ? 'l' : 'p';
                        const pdf = new jsPDF({
                            orientation: orientation,
                            unit: 'px',
                            format: [img.width, img.height]
                        });

                        pdf.addImage(e.target.result, 'JPEG', 0, 0, img.width, img.height);
                        
                        // Create valid uncorrupted blob stream
                        const blob = pdf.output('blob');
                        converterDownloadLink.href = URL.createObjectURL(blob);
                        converterDownloadLink.download = `${baseName}.pdf`;
                        converterDownloadLink.classList.remove('hidden');
                    } else {
                        // Regular canvas render path for image formats
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width; 
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);

                        canvas.toBlob((blob) => {
                            converterDownloadLink.href = URL.createObjectURL(blob);
                            converterDownloadLink.download = `${baseName}.${format.split('/')[1]}`;
                            converterDownloadLink.classList.remove('hidden');
                        }, format, 0.95);
                    }
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(activeConverterFile);
        });
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + ['Bytes', 'KB', 'MB', 'GB'][i];
    }
});

// ==========================================================================
// CRYPTO DONATION MECHANICS
// ==========================================================================
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

if(bmcTrigger) bmcTrigger.addEventListener('click', () => { bmcOverlay.classList.remove('bmc-hidden'); switchCryptoNetwork('sol'); });
if(bmcClose) bmcClose.addEventListener('click', () => bmcOverlay.classList.add('bmc-hidden'));
if(bmcTabs) { bmcTabs.forEach(t => t.addEventListener('click', () => { bmcTabs.forEach(x=>x.classList.remove('bmc-active')); t.classList.add('bmc-active'); switchCryptoNetwork(t.dataset.crypto); })); }
if(bmcCopyBtn) { bmcCopyBtn.addEventListener('click', () => { navigator.clipboard.writeText(bmcAddressInput.value); bmcCopyBtn.textContent='Copied!'; setTimeout(()=>bmcCopyBtn.textContent='Copy', 1500); }); }

function switchCryptoNetwork(ticker) {
    if (!bmcAddressInput) return;
    bmcAddressInput.value = cryptoConfig[ticker];
    if(bmcQrContainer) {
        bmcQrContainer.innerHTML = '';
        if(typeof QRCode !== 'undefined') new QRCode(bmcQrContainer, { text: cryptoConfig[ticker], width: 140, height: 140 });
    }
}