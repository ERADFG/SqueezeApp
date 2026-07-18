// ui.js - DOM Manipulation & Overlays
import { boardsList, initRoutingState } from './routing.js';

document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    const currentBoard = initRoutingState();

    // 1. Build Global Board Switcher Overlay
    const buildOverlay = () => {
        const overlay = document.createElement('div');
        overlay.className = 'board-overlay';
        overlay.id = 'global-board-switcher';
        
        let gridHTML = `<div class="board-grid-container"><h2 class="text-white text-xl font-bold mb-4 border-b border-neutral-800 pb-2">Jump to Board</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">`;
        
        boardsList.forEach(b => {
            gridHTML += `<a href="interactink.html?board=${b}" class="block p-3 rounded-lg border border-neutral-800 hover:bg-neutral-900 hover:border-neutral-700 transition text-center text-neutral-300 font-mono">/${b}/</a>`;
        });
        
        gridHTML += `</div><button id="close-overlay" class="mt-6 w-full py-3 bg-neutral-900 text-white rounded-lg font-bold hover:bg-neutral-800">Cancel</button></div>`;
        overlay.innerHTML = gridHTML;
        document.body.appendChild(overlay);

        // Toggle Logic
        document.querySelectorAll('.trigger-board-switcher').forEach(btn => {
            btn.addEventListener('click', () => overlay.classList.add('visible'));
        });
        
        document.getElementById('close-overlay').addEventListener('click', () => {
            overlay.classList.remove('visible');
        });
        overlay.addEventListener('click', (e) => {
            if(e.target === overlay) overlay.classList.remove('visible');
        });
    };

    buildOverlay();
});