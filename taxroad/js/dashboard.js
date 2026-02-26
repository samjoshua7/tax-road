import { auth, db, onAuthStateChanged, collection, query, getDocs, where, signOut, doc, getDoc } from './firebase-config.js';
import { formatCurrency, formatDate, loadComponents, showToast, setPageTitle } from './utils.js';

let currentUser = null;

// Initialize Dashboard
async function initDashboard() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        // Load UI components and user profile IN PARALLEL
        await loadComponents();

        setupNavigation();
        await Promise.all([loadUserProfile(), fetchDashboardData()]);
    });
}

function setupNavigation() {
    const sidebar = document.getElementById('sidebar-container');
    const hamburgerBtn = document.getElementById('hamburger-btn');
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

    setPageTitle('Dashboard Overview');

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await signOut(auth);
            } catch (error) {
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
        console.error('[TAX ROAD] Error loading user profile:', error);
    }
}

async function fetchDashboardData() {
    const tbody = document.getElementById('recent-invoices-body');
    const tableContainer = tbody?.closest('.table-container');

    try {
        // Show loading state
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-lg"><div class="loader mx-auto"></div><div class="text-muted mt-sm">Loading...</div></td></tr>`;
            if (tableContainer) tableContainer.style.opacity = '0.7';
        }

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const isoThirtyDaysAgo = thirtyDaysAgo.toISOString();

        // ✅ FIX: Fetch invoices and receipts IN PARALLEL (was sequential before)
        const [invoiceSnaps, receiptSnaps] = await Promise.all([
            getDocs(query(collection(db, `users/${currentUser.uid}/invoices`), where('createdAt', '>=', isoThirtyDaysAgo))),
            // ✅ FIX: Receipts use `date` field (string), createdAt is a Firestore Timestamp — type mismatch fixed
            getDocs(query(collection(db, `users/${currentUser.uid}/receipts`), where('date', '>=', thirtyDaysAgo.toISOString().split('T')[0])))
        ]);

        let totalSales = 0;
        let totalGst = 0;
        const recentInvoices = [];

        invoiceSnaps.forEach(docSnap => {
            const data = docSnap.data();
            totalSales += Number(data.total) || 0;
            totalGst += Number(data.gstAmount) || 0;
            recentInvoices.push({ id: docSnap.id, ...data });
        });

        let totalIncome = 0;
        receiptSnaps.forEach(docSnap => {
            totalIncome += Number(docSnap.data().amountReceived) || 0;
        });

        // Correct GST Accounting: Revenue = Sales - GST Liability
        const revenue = totalSales - totalGst;
        const netProfit = revenue;

        document.getElementById('stat-sales').textContent = formatCurrency(totalSales);
        document.getElementById('stat-gst').textContent = formatCurrency(totalGst);
        document.getElementById('stat-income').textContent = formatCurrency(totalIncome);
        document.getElementById('stat-profit').textContent = formatCurrency(netProfit);

        if (tableContainer) tableContainer.style.opacity = '1';

        // Sort and render top 5 most recent invoices
        recentInvoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        await renderRecentInvoices(recentInvoices.slice(0, 5));

    } catch (error) {
        console.error('[TAX ROAD] Error fetching dashboard data:', error);
        showToast("Failed to load dashboard data.", "error");
        if (tbody) {
            if (tableContainer) tableContainer.style.opacity = '1';
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

    // ✅ FIX: Batch-fetch all unique customer docs IN PARALLEL instead of N+1 sequential getDoc calls
    const uniqueCustomerIds = [...new Set(invoices.map(inv => inv.customerId).filter(Boolean))];
    const customerDocs = await Promise.all(
        uniqueCustomerIds.map(id => getDoc(doc(db, `users/${currentUser.uid}/customers`, id)))
    );

    const customerMap = {};
    customerDocs.forEach(cDoc => {
        if (cDoc.exists()) customerMap[cDoc.id] = cDoc.data().partyName || 'Unknown';
    });

    let html = '';
    invoices.forEach(inv => {
        const customerName = customerMap[inv.customerId] || 'Unknown';
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
    });

    tbody.innerHTML = html;
}

// Run init
initDashboard();
