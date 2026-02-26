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

    toast.innerHTML = `${icon}<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
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

export function setPageTitle(title) {
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.textContent = title;
}

// Load common components (Sidebar, Topnav) — fetched IN PARALLEL to cut latency
export async function loadComponents() {
    try {
        const version = Date.now();

        // ✅ FIX: Fetch both components simultaneously (was serial before — ~400-800ms slower)
        const [sidebarResponse, topnavResponse] = await Promise.all([
            fetch(`components/sidebar.html?v=${version}`),
            fetch(`components/topnav.html?v=${version}`)
        ]);

        if (!sidebarResponse.ok) throw new Error(`Sidebar fetch failed: HTTP ${sidebarResponse.status}`);
        if (!topnavResponse.ok) throw new Error(`Topnav fetch failed: HTTP ${topnavResponse.status}`);

        const [sidebarHtml, topnavHtml] = await Promise.all([
            sidebarResponse.text(),
            topnavResponse.text()
        ]);

        const sidebarContainer = document.getElementById('sidebar-container');
        const topnavContainer = document.getElementById('topnav-container');

        if (sidebarContainer) sidebarContainer.innerHTML = sidebarHtml;
        else console.error('[TAX ROAD] sidebar-container not found in DOM');

        if (topnavContainer) topnavContainer.innerHTML = topnavHtml;
        else console.error('[TAX ROAD] topnav-container not found in DOM');

        // Set active nav item
        const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
        const navId = `nav-${currentPath.replace('.html', '')}`;
        const activeNav = document.getElementById(navId);
        if (activeNav) activeNav.classList.add('active');

    } catch (error) {
        console.error('[TAX ROAD] Critical error loading components:', error);
    }
}
