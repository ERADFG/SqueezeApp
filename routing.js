/**
 * routing.js
 * ---------------------------------------------------------------------------
 * InteractInk — Unified Routing & State Management (Task 1)
 *
 * Responsibilities:
 *   1. Define the canonical list of the 20 boards (id, label, description).
 *   2. Resolve the active board from the URL (?board=xxx), with validation
 *      and a safe fallback to the default board.
 *   3. Persist "where the user was" (board + scroll position) in
 *      sessionStorage so that returning via the Back button (or re-opening
 *      interactink.html) restores the exact board and scroll offset.
 *   4. Provide small helpers for building board URLs and navigating between
 *      boards without a full-page reload where possible.
 *
 * This file has no dependencies and can be safely included on every page
 * (board feed, thread pages, settings, etc.) via:
 *     <script src="js/routing.js"></script>
 * ---------------------------------------------------------------------------
 */

(function (global) {
    'use strict';

    // -------------------------------------------------------------------
    // 1. Board registry — single source of truth for all 20 boards.
    //    (Rendered as the board grid / switcher in later tasks.)
    // -------------------------------------------------------------------
    const BOARDS = [
        { id: 'b',          label: '/b/',          name: 'Random',                              icon: 'shuffle' },
        { id: 'v',          label: '/v/',          name: 'Video Games',                          icon: 'gamepad-2' },
        { id: 'g',          label: '/g/',          name: 'Technology',                           icon: 'cpu' },
        { id: 'politics',   label: '/politics/',   name: 'Politics',                              icon: 'landmark' },
        { id: 'adv',        label: '/adv/',        name: 'Advice',                                icon: 'heart-handshake' },
        { id: 'news',       label: '/news/',       name: 'World News',                            icon: 'globe' },
        { id: 'coding',     label: '/coding/',     name: 'Coding',                                icon: 'code-2' },
        { id: 'media',      label: '/media/',      name: 'Movies & Anime',                        icon: 'clapperboard' },
        { id: 'q',          label: '/q/',          name: 'Quick Questions',                       icon: 'help-circle' },
        { id: 'drama',      label: '/drama/',      name: 'Drama & Hype',                          icon: 'flame' },
        { id: 'lookism',    label: '/lookism/',    name: 'Lookism (Looksmaxxing & Aesthetics)',   icon: 'sparkles' },
        { id: 'biz',        label: '/biz/',        name: 'Finance & Crypto',                      icon: 'trending-up' },
        { id: 'sci',        label: '/sci/',        name: 'Science & Math',                        icon: 'flask-conical' },
        { id: 'lit',        label: '/lit/',        name: 'Literature',                            icon: 'book-open' },
        { id: 'vt',         label: '/vt/',         name: 'Virtual YouTubers',                     icon: 'video' },
        { id: 'out',        label: '/out/',        name: 'Outdoors',                              icon: 'mountain' },
        { id: 'sync',       label: '/sync/',       name: 'Shared Experiences',                    icon: 'users' },
        { id: 'hobbies',    label: '/hobbies/',    name: 'Hobbies',                                icon: 'palette' },
        { id: 'philosophy', label: '/philosophy/', name: 'Philosophy',                             icon: 'brain' },
        { id: 'debate',     label: '/debate/',     name: 'Debate',                                 icon: 'swords' }
    ];

    const BOARD_MAP = BOARDS.reduce((acc, b) => { acc[b.id] = b; return acc; }, {});
    const DEFAULT_BOARD = 'b';

    // -------------------------------------------------------------------
    // 2. sessionStorage keys
    // -------------------------------------------------------------------
    const STATE_KEY = 'ii_board_state_v1'; // { board, scrollY, updatedAt }
    const SCROLL_SAVE_THROTTLE_MS = 200;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /** Is `id` a real, known board? */
    function isValidBoard(id) {
        return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BOARD_MAP, id);
    }

    /** Look up board metadata by id (or null). */
    function getBoardMeta(id) {
        return BOARD_MAP[id] || null;
    }

    /**
     * Resolve the active board for the current page load, purely from the
     * URL's `?board=` param. Falls back to DEFAULT_BOARD if missing/invalid.
     * (Does NOT consult sessionStorage — URL is always the source of truth
     * for "what board is this page showing". sessionStorage is only used to
     * decide the *initial* URL when none is present — see resolveInitialBoard.)
     */
    function getBoardFromURL() {
        const params = new URLSearchParams(global.location.search);
        const requested = params.get('board');
        return isValidBoard(requested) ? requested : DEFAULT_BOARD;
    }

    /**
     * For entry points that don't have a ?board= param at all (e.g. a bare
     * link to interactink.html), fall back to the last board the user was
     * viewing this session, if any, otherwise DEFAULT_BOARD.
     */
    function resolveInitialBoard() {
        const params = new URLSearchParams(global.location.search);
        if (params.has('board')) return getBoardFromURL();

        const saved = readState();
        if (saved && isValidBoard(saved.board)) return saved.board;

        return DEFAULT_BOARD;
    }

    /** Build a URL (relative) to a given board on the board-viewer page. */
    function buildBoardUrl(boardId, basePath) {
        const path = basePath || 'interactink.html';
        const id = isValidBoard(boardId) ? boardId : DEFAULT_BOARD;
        return `${path}?board=${encodeURIComponent(id)}`;
    }

    /** Build a URL to a specific thread within a board. */
    function buildThreadUrl(boardId, threadId, basePath) {
        const path = basePath || 'thread.html';
        const id = isValidBoard(boardId) ? boardId : DEFAULT_BOARD;
        return `${path}?board=${encodeURIComponent(id)}&thread=${encodeURIComponent(threadId)}`;
    }

    // -------------------------------------------------------------------
    // 3. State persistence (board + scroll position)
    // -------------------------------------------------------------------

    function readState() {
        try {
            const raw = sessionStorage.getItem(STATE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            console.warn('[routing] failed to read session state', err);
            return null;
        }
    }

    function writeState(partial) {
        try {
            const current = readState() || {};
            const next = Object.assign({}, current, partial, { updatedAt: Date.now() });
            sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
        } catch (err) {
            console.warn('[routing] failed to write session state', err);
        }
    }

    /** Record which board the user is currently on. */
    function saveCurrentBoard(boardId) {
        if (!isValidBoard(boardId)) return;
        writeState({ board: boardId });
    }

    /** Record the current scroll offset for the active board's feed. */
    function saveScrollPosition(boardId, scrollY) {
        if (!isValidBoard(boardId)) return;
        writeState({ board: boardId, scrollY: Math.max(0, Math.round(scrollY)) });
    }

    /**
     * Returns the saved scroll offset for `boardId`, but only if the saved
     * state was actually captured while viewing that same board (prevents
     * restoring a /v/ scroll position onto a fresh /lookism/ load).
     */
    function getSavedScrollPosition(boardId) {
        const state = readState();
        if (!state || state.board !== boardId || typeof state.scrollY !== 'number') return 0;
        return state.scrollY;
    }

    /**
     * Wires up automatic scroll-position tracking for the given board.
     * Call once per page load. Saves are throttled and also flushed on
     * pagehide/visibilitychange so nothing is lost right before navigation.
     */
    function trackScrollPosition(boardId) {
        let pending = false;
        function flush() {
            pending = false;
            saveScrollPosition(boardId, global.scrollY || global.pageYOffset || 0);
        }
        global.addEventListener('scroll', () => {
            if (pending) return;
            pending = true;
            setTimeout(flush, SCROLL_SAVE_THROTTLE_MS);
        }, { passive: true });

        global.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
    }

    /**
     * Attempts to restore the scroll position saved for `boardId`. Should be
     * called after the feed has finished its initial render (so the page
     * actually has enough height to scroll to the saved offset).
     */
    function restoreScrollPosition(boardId) {
        const y = getSavedScrollPosition(boardId);
        if (y > 0) {
            // Defer to next frame so layout has settled.
            requestAnimationFrame(() => global.scrollTo({ top: y, behavior: 'auto' }));
        }
    }

    /**
     * Call immediately before navigating away to a thread (or any other
     * page) so the Back button returns to the right spot even if the
     * scroll-throttle hasn't fired yet.
     */
    function captureStateBeforeNavigation(boardId) {
        saveScrollPosition(boardId, global.scrollY || global.pageYOffset || 0);
    }

    /**
     * Thread-page "Back" button. Prefers real browser history (so it works
     * naturally whether the user arrived via the feed, a shared link, or a
     * cross-link) but falls back to a constructed board URL — with the
     * board_id read from sessionStorage/URL — if there's no history to pop
     * to (e.g. the thread was opened directly from an external link).
     */
    function goBackToBoard(boardId, basePath) {
        const fallback = buildBoardUrl(boardId || resolveInitialBoard(), basePath);
        if (global.history.length > 1 && document.referrer) {
            global.history.back();
            // Safety net: if history.back() doesn't actually navigate away
            // (e.g. same-page hash-only history), land on the board feed.
            setTimeout(() => {
                if (document.hasFocus && document.visibilityState === 'visible') {
                    global.location.href = fallback;
                }
            }, 600);
        } else {
            global.location.href = fallback;
        }
    }

    // -------------------------------------------------------------------
    // 4. Shared board-grid renderer
    //    Used by the index.html landing hub (Task 2) and reused as-is by
    //    the global board-switcher overlay (Task 3) so the two surfaces
    //    never drift out of sync.
    // -------------------------------------------------------------------

    /**
     * Renders the 20-board grid into `container`.
     * options:
     *   basePath   {string}   page to link to (default 'interactink.html')
     *   activeId   {string}   board id to visually mark as active
     *   onSelect   {function} if provided, clicks are intercepted
     *                         (preventDefault) and this is called with the
     *                         board id instead of following the link.
     */
    function renderBoardGrid(container, options) {
        if (!container) return;
        const opts = options || {};
        const basePath = opts.basePath || 'interactink.html';

        container.innerHTML = BOARDS.map(b => `
            <a href="${buildBoardUrl(b.id, basePath)}"
               class="board-grid-card${b.id === opts.activeId ? ' active' : ''}"
               data-board-id="${b.id}">
                <div class="board-grid-icon"><i data-lucide="${b.icon}"></i></div>
                <div class="board-grid-meta">
                    <div class="board-grid-label">${b.label}</div>
                    <div class="board-grid-name">${b.name}</div>
                </div>
            </a>
        `).join('');

        if (typeof opts.onSelect === 'function') {
            container.querySelectorAll('[data-board-id]').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    opts.onSelect(el.getAttribute('data-board-id'));
                });
            });
        }

        if (global.lucide) global.lucide.createIcons();
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    global.InkRouting = {
        BOARDS,
        DEFAULT_BOARD,
        isValidBoard,
        getBoardMeta,
        getBoardFromURL,
        resolveInitialBoard,
        buildBoardUrl,
        buildThreadUrl,
        saveCurrentBoard,
        saveScrollPosition,
        getSavedScrollPosition,
        trackScrollPosition,
        restoreScrollPosition,
        captureStateBeforeNavigation,
        renderBoardGrid,
        goBackToBoard
    };

})(window);
