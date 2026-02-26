import { auth, db, onAuthStateChanged, collection, query, getDocs, where, signOut, doc, getDoc } from './firebase-config.js';
import { formatCurrency, formatDate, loadComponents, showToast } from './utils.js';

let currentUser = null;

// Initialize Dashboard
async function initDashboard() {
    // 1. Check Auth State First
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        // 2. Load UI Components (Sidebar, Topnav)
        await loadComponents();
        setupNavigation();

        // 3. Load User Profile (for Topnav Display)
        await loadUserProfile();

        // 4. Fetch Dashboard Data
        await fetchDashboardData();
    });
}

function setupNavigation() {
    // Mobile Hamburger
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar-container');
    const overlay = document.getElementById('mobile-overlay');

    if (hamburgerBtn && sidebar && overlay) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    }

    // Logout Button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await signOut(auth);
            } catch (error) {
                console.error("Logout Error:", error);
                showToast("Error during logout", "error");
            }
        });
    }
}

async function loadUserProfile() {
    try {
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            const nameDisplay = document.getElementById('user-display-name');
            if (nameDisplay && userData.businessName) {
                nameDisplay.textContent = userData.businessName;
                nameDisplay.style.display = 'block';
            }
        }
    } catch (error) {
        console.error("Error loading user profile:", error);
    }
}

async function fetchDashboardData() {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const isoThirtyDaysAgo = thirtyDaysAgo.toISOString();

        // 1. Fetch Invoices (Last 30 Days)
        const invoicesRef = collection(db, `users/${currentUser.uid}/invoices`);
        const qInvoices = query(invoicesRef, where("createdAt", ">=", isoThirtyDaysAgo));
        const invoiceSnaps = await getDocs(qInvoices);

        let totalSales = 0;
        let totalGst = 0;
        let recentInvoices = [];

        invoiceSnaps.forEach(docSnap => {
            const data = docSnap.data();
            totalSales += Number(data.total) || 0;
            totalGst += Number(data.gstAmount) || 0;
            recentInvoices.push({ id: docSnap.id, ...data });
        });

        // 2. Fetch Receipts (Last 30 Days)
        const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
        const qReceipts = query(receiptsRef, where("createdAt", ">=", isoThirtyDaysAgo));
        const receiptSnaps = await getDocs(qReceipts);

        let totalIncome = 0;
        receiptSnaps.forEach(docSnap => {
            const data = docSnap.data();
            totalIncome += Number(data.amountReceived) || 0;
        });

        // 3. Calculate Net Profit
        const netProfit = totalIncome - totalGst;

        // 4. Update UI Stats
        document.getElementById('stat-sales').textContent = formatCurrency(totalSales);
        document.getElementById('stat-gst').textContent = formatCurrency(totalGst);
        document.getElementById('stat-income').textContent = formatCurrency(totalIncome);
        document.getElementById('stat-profit').textContent = formatCurrency(netProfit);

        // 5. Render Recent Invoices
        // Sort by date desc (naive client side for now)
        recentInvoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderRecentInvoices(recentInvoices.slice(0, 5)); // Take top 5

    } catch (error) {
        console.error("Error fetching dashboard data:", error);
        showToast("Failed to load dashboard data.", "error");

        // Show empty state in table
        const tbody = document.getElementById('recent-invoices-body');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-error">Failed to load data</td></tr>`;
        }
    }
}

async function renderRecentInvoices(invoices) {
    const tbody = document.getElementById('recent-invoices-body');
    if (!tbody) return;

    if (invoices.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-md">No recent invoices found.</td></tr>`;
        return;
    }

    let html = '';

    // We need customer names. For a small dashboard list, we can fetch individually or batch.
    // For simplicity, we'll fetch them sequentially here for the top 5.
    for (const inv of invoices) {
        let customerName = 'Unknown';
        if (inv.customerId) {
            try {
                const cDoc = await getDoc(doc(db, `users/${currentUser.uid}/customers`, inv.customerId));
                if (cDoc.exists()) {
                    customerName = cDoc.data().partyName || 'Unknown';
                }
            } catch (e) { console.error("Error fetching customer", e); }
        }

        const statusClass = inv.status === 'Paid' ? 'badge-success' :
            inv.status === 'Partially Paid' ? 'badge-warning' : 'badge-error';
        const displayStatus = inv.status || 'Pending';

        html += `
            <tr>
                <td class="font-bold">${inv.invoiceNumber || 'N/A'}</td>
                <td>${customerName}</td>
                <td>${formatDate(inv.createdAt)}</td>
                <td class="font-bold">${formatCurrency(inv.total || 0)}</td>
                <td><span class="badge ${statusClass}">${displayStatus}</span></td>
            </tr>
        `;
    }

    tbody.innerHTML = html;
}

// Run init
initDashboard();
