// Utility functions for Toast Notifications, Loading, and Common UI

export function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = type === 'success'
        ? '<svg class="icon" style="color: var(--accent)" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
        : '<svg class="icon" style="color: var(--text-error)" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';

    toast.innerHTML = `
        ${icon}
        <span>${message}</span>
    `;

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export function formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR'
    }).format(amount);
}

export function formatDate(dateString) {
    if (!dateString) return '';
    const options = { year: 'numeric', month: 'short', day: 'numeric' };
    return new Date(dateString).toLocaleDateString('en-IN', options);
}

export function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

export function setPageTitle(title) {
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) {
        pageTitle.textContent = title;
        console.log(`[TAX ROAD DEBUG] Page title set to: ${title}`);
    } else {
        console.warn('[TAX ROAD WARN] Page title element not found');
    }
}

// Load common components (Sidebar, Topnav)
export async function loadComponents() {
    try {
        console.log('[TAX ROAD DEBUG] Loading components...');

        // Load Sidebar
        try {
            console.log('[TAX ROAD DEBUG] Fetching sidebar_v2.html...');
            const version = new Date().getTime();
            const sidebarResponse = await fetch(`components/sidebar_v2.html?v=${version}`);

            if (!sidebarResponse.ok) {
                throw new Error(`HTTP ${sidebarResponse.status}: ${sidebarResponse.statusText}`);
            }

            const sidebarHtml = await sidebarResponse.text();
            console.log('[TAX ROAD DEBUG] Sidebar HTML fetched, length:', sidebarHtml.length);
            console.log('[TAX ROAD DEBUG] Sidebar HTML content preview:', sidebarHtml.substring(0, 200));

            // Check if logout button exists in HTML
            if (sidebarHtml.includes('logout-btn')) {
                console.log('[TAX ROAD DEBUG] ✓ logout-btn found in sidebar HTML');
            } else {
                console.error('[TAX ROAD ERROR] ✗ logout-btn NOT in sidebar HTML - THIS IS THE PROBLEM!');
            }

            // Check if sidebar-nav exists
            if (sidebarHtml.includes('sidebar-nav')) {
                console.log('[TAX ROAD DEBUG] ✓ sidebar-nav found in sidebar HTML');
            } else {
                console.error('[TAX ROAD ERROR] ✗ sidebar-nav NOT in sidebar HTML');
            }

            const sidebarContainer = document.getElementById('sidebar-container');

            if (!sidebarContainer) {
                console.error('[TAX ROAD ERROR] Sidebar container element not found in DOM');
            } else {
                console.log('[TAX ROAD DEBUG] Sidebar container found, inserting HTML...');
                sidebarContainer.innerHTML = sidebarHtml;

                // Verify insertion
                console.log('[TAX ROAD DEBUG] Sidebar container innerHTML length:', sidebarContainer.innerHTML.length);

                // Check if logout button now exists in DOM
                const logoutBtn = document.getElementById('logout-btn');
                if (logoutBtn) {
                    console.log('[TAX ROAD DEBUG] ✓ logout-btn FOUND in DOM after insertion');
                } else {
                    console.error('[TAX ROAD ERROR] ✗ logout-btn NOT FOUND in DOM - Check sidebar HTML!');
                }

                // Check all button elements in sidebar
                const buttons = sidebarContainer.querySelectorAll('button');
                console.log(`[TAX ROAD DEBUG] Total buttons in sidebar: ${buttons.length}`);
                buttons.forEach((btn, idx) => {
                    console.log(`[TAX ROAD DEBUG] Button ${idx}: id="${btn.id}", text="${btn.textContent.trim()}"`);
                });

                console.log('[TAX ROAD DEBUG] Sidebar loaded successfully');
            }
        } catch (sidebarError) {
            console.error('[TAX ROAD ERROR] Failed to load sidebar:', sidebarError);
            console.error('[TAX ROAD DEBUG] Make sure components/sidebar.html exists');
        }

        // Load Topnav
        try {
            console.log('[TAX ROAD DEBUG] Fetching topnav.html...');
            const version = new Date().getTime();
            const topnavResponse = await fetch(`components/topnav.html?v=${version}`);

            if (!topnavResponse.ok) {
                throw new Error(`HTTP ${topnavResponse.status}: ${topnavResponse.statusText}`);
            }

            const topnavHtml = await topnavResponse.text();
            console.log('[TAX ROAD DEBUG] Topnav HTML fetched, length:', topnavHtml.length);
            console.log('[TAX ROAD DEBUG] Topnav HTML content preview:', topnavHtml.substring(0, 200));

            const topnavContainer = document.getElementById('topnav-container');

            if (!topnavContainer) {
                console.error('[TAX ROAD ERROR] Topnav container element not found in DOM');
            } else {
                console.log('[TAX ROAD DEBUG] Topnav container found, inserting HTML...');
                topnavContainer.innerHTML = topnavHtml;

                // Verify insertion
                console.log('[TAX ROAD DEBUG] Topnav container innerHTML length:', topnavContainer.innerHTML.length);

                // Check if page-title exists
                const pageTitle = document.getElementById('page-title');
                if (pageTitle) {
                    console.log('[TAX ROAD DEBUG] ✓ page-title FOUND in DOM');
                } else {
                    console.error('[TAX ROAD ERROR] ✗ page-title NOT FOUND in DOM');
                }

                console.log('[TAX ROAD DEBUG] Topnav loaded successfully');
            }
        } catch (topnavError) {
            console.error('[TAX ROAD ERROR] Failed to load topnav:', topnavError);
            console.error('[TAX ROAD DEBUG] Make sure components/topnav.html exists');
        }

        // Init Sidebar active state
        try {
            const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
            const navId = `nav-${currentPath.replace('.html', '')}`;

            console.log(`[TAX ROAD DEBUG] Current path: ${currentPath}, Nav ID to activate: ${navId}`);

            const activeNav = document.getElementById(navId);
            if (activeNav) {
                activeNav.classList.add('active');
                console.log(`[TAX ROAD DEBUG] Activated nav item: ${navId}`);
            } else {
                console.warn(`[TAX ROAD WARN] Nav item not found: ${navId}`);
            }
        } catch (navError) {
            console.error('[TAX ROAD ERROR] Failed to set active nav:', navError);
        }

    } catch (error) {
        console.error('[TAX ROAD ERROR] Critical error loading components:', error);
    }
}

