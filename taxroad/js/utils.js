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

// Load common components (Sidebar, Topnav)
export async function loadComponents() {
    try {
        // Load Sidebar
        const sidebarHtml = await fetch('components/sidebar.html').then(res => res.text());
        const sidebarContainer = document.getElementById('sidebar-container');
        if (sidebarContainer) sidebarContainer.innerHTML = sidebarHtml;

        // Load Topnav
        const topnavHtml = await fetch('components/topnav.html').then(res => res.text());
        const topnavContainer = document.getElementById('topnav-container');
        if (topnavContainer) topnavContainer.innerHTML = topnavHtml;

        // Init Sidebar active state
        const currentPath = window.location.pathname.split('/').pop();
        const navId = currentPath ? `nav-${currentPath.replace('.html', '')}` : 'nav-dashboard';
        const activeNav = document.getElementById(navId);
        if (activeNav) activeNav.classList.add('active');

    } catch (error) {
        console.error('Error loading components:', error);
    }
}
