const InkRouting = {
    DEFAULT_BOARD: 'general',
    
    // The 20-board registry
    boards: [
        { id: 'general', label: '/general/', name: 'General Discussion' },
        { id: 'tech', label: '/tech/', name: 'Technology & Dev' },
        { id: 'design', label: '/design/', name: 'Art & Design' },
        { id: 'science', label: '/sci/', name: 'Science & Math' },
        { id: 'books', label: '/lit/', name: 'Literature' },
        { id: 'music', label: '/music/', name: 'Music & Audio' },
        { id: 'film', label: '/film/', name: 'Movies & TV' },
        { id: 'games', label: '/v/', name: 'Video Games' },
        { id: 'fitness', label: '/fit/', name: 'Fitness & Health' },
        { id: 'food', label: '/cook/', name: 'Cooking & Raw' },
        { id: 'travel', label: '/trv/', name: 'Travel & Maps' },
        { id: 'history', label: '/his/', name: 'History' },
        { id: 'politics', label: '/pol/', name: 'Politics' },
        { id: 'business', label: '/biz/', name: 'Business & Trade' },
        { id: 'nature', label: '/nat/', name: 'Nature' },
        { id: 'auto', label: '/auto/', name: 'Automotive' },
        { id: 'fashion', label: '/fa/', name: 'Fashion' },
        { id: 'work', label: '/work/', name: 'Work & Jobs' },
        { id: 'philosophy', label: '/philo/', name: 'Philosophy' },
        { id: 'random', label: '/b/', name: 'Random' }
    ],

    getBoardMeta(boardId) {
        return this.boards.find(b => b.id === boardId) || { id: 'general', label: '/general/', name: 'General' };
    },

    renderBoardGrid(container) {
        if (!container) return;
        container.innerHTML = this.boards.map(board => `
            <a href="interactink.html?board=${board.id}" class="board-grid-card">
                <div class="board-grid-icon">
                    <i data-lucide="hash"></i>
                </div>
                <div class="board-grid-meta">
                    <div class="board-grid-label">${board.label}</div>
                    <div class="board-grid-name">${board.name}</div>
                </div>
            </a>
        `).join('');
        // Re-run icon rendering for the dynamically added elements
        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    buildThreadUrl(boardId, threadId, basePage) {
        return `${basePage}?board=${boardId}&thread=${threadId}`;
    }
};