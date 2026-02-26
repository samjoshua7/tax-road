import { auth, db, onAuthStateChanged, collection, query, getDocs, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc, signOut, where } from './firebase-config.js';
import { loadComponents, showToast, setPageTitle } from './utils.js';

let currentUser = null;
let customers = [];
let allCustomersRaw = []; // Store raw list for search filtering

// DOM Elements
const tbody = document.getElementById('customers-body');
const searchInput = document.getElementById('global-search');
const modal = document.getElementById('customer-modal');
const form = document.getElementById('customer-form');
const btnAdd = document.getElementById('btn-add-customer');
const btnClose = document.getElementById('modal-close');
const btnCancel = document.getElementById('btn-cancel');
const modalTitle = document.getElementById('modal-title');

// Initialize
async function initCustomers() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        await loadComponents();
        setupNavigation();
        setupEventListeners();

        // Profile and data load in parallel
        await Promise.all([loadUserProfile(), fetchCustomers()]);
    });
}

function setupNavigation() {
    console.log('[TAX ROAD DEBUG] === SETUP NAVIGATION START ===');

    // Debug: Check sidebar in DOM
    const sidebar = document.getElementById('sidebar-container');
    console.log('[TAX ROAD DEBUG] Sidebar container exists:', !!sidebar);
    if (sidebar) {
        console.log('[TAX ROAD DEBUG] Sidebar innerHTML length:', sidebar.innerHTML.length);
        console.log('[TAX ROAD DEBUG] Sidebar innerHTML:', sidebar.innerHTML.substring(0, 300));
    }

    const hamburgerBtn = document.getElementById('hamburger-btn');
    const overlay = document.getElementById('mobile-overlay');

    console.log('[TAX ROAD DEBUG] Hamburger btn found:', !!hamburgerBtn);
    console.log('[TAX ROAD DEBUG] Overlay found:', !!overlay);

    if (hamburgerBtn && sidebar && overlay) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    } else {
        console.warn('[TAX ROAD WARN] Hamburger navigation elements not found');
    }

    // Set Page Title
    setPageTitle('Customers');

    // CRITICAL: Debug logout button
    console.log('[TAX ROAD DEBUG] === SEARCHING FOR LOGOUT BUTTON ===');
    const logoutBtn = document.getElementById('logout-btn');
    console.log('[TAX ROAD DEBUG] Logout button found:', !!logoutBtn);

    if (logoutBtn) {
        console.log('[TAX ROAD DEBUG] ✓ Logout button FOUND - Adding click listener');
        console.log('[TAX ROAD DEBUG] Button element:', logoutBtn.tagName, 'id=' + logoutBtn.id, 'text=' + logoutBtn.textContent);
        logoutBtn.addEventListener('click', async () => {
            try {
                console.log('[TAX ROAD DEBUG] Logging out user...');
                await signOut(auth);
                console.log('[TAX ROAD DEBUG] Logout successful');
            } catch (error) {
                console.error('[TAX ROAD ERROR] Logout Error:', error);
                showToast("Error during logout", "error");
            }
        });
    } else {
        console.error('[TAX ROAD ERROR] ✗ Logout button NOT found');
        console.error('[TAX ROAD DEBUG] All buttons in sidebar:');
        const allButtons = document.querySelectorAll('button');
        allButtons.forEach((btn, idx) => {
            console.error(`[TAX ROAD DEBUG]   Button ${idx}: id="${btn.id}", class="${btn.className}", text="${btn.textContent.trim()}"`);
        });
        console.error('[TAX ROAD DEBUG] Sidebar HTML search for "logout":',
            sidebar?.innerHTML?.includes('logout') ? '✓ FOUND' : '✗ NOT FOUND');
    }

    // Connect Search
    const searchInputInst = document.getElementById('global-search');
    if (searchInputInst) {
        searchInputInst.addEventListener('input', (e) => {
            console.log(`[TAX ROAD DEBUG] Searching customers for: ${e.target.value}`);
            filterCustomers(e.target.value);
        });
    } else {
        console.warn('[TAX ROAD WARN] Search input not found');
    }

    console.log('[TAX ROAD DEBUG] === SETUP NAVIGATION END ===\n');
}

async function loadUserProfile() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching user profile from Firestore...');
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            console.log('[TAX ROAD DEBUG] User profile loaded:', userData.businessName);
            const nameDisplay = document.getElementById('user-display-name');
            if (nameDisplay && userData.businessName) {
                nameDisplay.textContent = userData.businessName;
                nameDisplay.style.display = 'block';
            }
        } else {
            console.warn('[TAX ROAD WARN] No user profile found in Firestore');
        }
    } catch (e) {
        console.error('[TAX ROAD ERROR] Error loading user profile:', e);
    }
}

function setupEventListeners() {
    btnAdd.addEventListener('click', () => openModal());
    btnClose.addEventListener('click', closeModal);
    btnCancel.addEventListener('click', closeModal);

    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    form.addEventListener('submit', handleSaveCustomer);
}

function openModal(customer = null) {
    if (customer) {
        modalTitle.textContent = 'Edit Customer';
        document.getElementById('customer-id').value = customer.id;
        document.getElementById('cust-name').value = customer.partyName;
        document.getElementById('cust-phone').value = customer.phone;
        document.getElementById('cust-gst').value = customer.gstNumber || '';
        document.getElementById('cust-address').value = customer.shippingAddress;
    } else {
        modalTitle.textContent = 'Add Customer';
        form.reset();
        document.getElementById('customer-id').value = '';
    }
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    form.reset();
}

async function fetchCustomers() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching customers from Firestore...');

        // Show loading state
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-lg"><div class="loader mx-auto"></div><div class="text-muted mt-sm">Loading customers...</div></td></tr>`;
            tbody.closest('.table-container').style.opacity = '0.7';
        }

        const customersRef = collection(db, `users/${currentUser.uid}/customers`);
        // Simple order by party name might require index, fetching all and sorting client side for MVP
        const q = query(customersRef);
        const snaps = await getDocs(q);

        allCustomersRaw = [];
        snaps.forEach(snap => {
            allCustomersRaw.push({ id: snap.id, ...snap.data() });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${allCustomersRaw.length} customers`);

        // Sort alphabetically
        allCustomersRaw.sort((a, b) => a.partyName.localeCompare(b.partyName));

        if (tbody) tbody.closest('.table-container').style.opacity = '1';
        renderCustomers(allCustomersRaw);
    } catch (error) {
        console.error("[TAX ROAD ERROR] Error fetching customers:", error);
        showToast("Failed to load customers.", "error");
        if (tbody) {
            tbody.closest('.table-container').style.opacity = '1';
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-error">Failed to load data</td></tr>`;
        }
    }
}

function filterCustomers(searchTerm) {
    if (!searchTerm) {
        renderCustomers(allCustomersRaw);
        return;
    }

    const lowerTerm = searchTerm.toLowerCase();
    const filtered = allCustomersRaw.filter(c =>
        (c.partyName && c.partyName.toLowerCase().includes(lowerTerm)) ||
        (c.phone && c.phone.includes(lowerTerm)) ||
        (c.gstNumber && c.gstNumber.toLowerCase().includes(lowerTerm))
    );

    renderCustomers(filtered);
}

function renderCustomers(dataList) {
    if (!tbody) return;

    if (dataList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-md">No customers found.</td></tr>`;
        return;
    }

    let html = '';
    dataList.forEach(c => {
        // Prevent XSS playfully
        const escName = escapeHtml(c.partyName);
        const escPhone = escapeHtml(c.phone);
        const escGst = escapeHtml(c.gstNumber || 'N/A');
        const escAddr = escapeHtml(c.shippingAddress);

        html += `
            <tr data-id="${c.id}">
                <td class="font-bold text-primary">${escName}</td>
                <td>${escPhone}</td>
                <td><span class="badge ${c.gstNumber ? 'badge-success' : 'badge-warning'}">${escGst}</span></td>
                <td><div style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escAddr}">${escAddr}</div></td>
                <td class="actions-cell">
                    <button class="btn btn-outline btn-edit" style="padding: 6px; border-color: var(--accent); color: var(--accent);" title="Edit">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <button class="btn btn-outline btn-delete" style="padding: 6px; border-color: var(--text-error); color: var(--text-error);" title="Delete">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;

    // Attach Edit/Delete Listeners
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tr = e.target.closest('tr');
            const id = tr.dataset.id;
            const customer = allCustomersRaw.find(c => c.id === id);
            if (customer) openModal(customer);
        });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tr = e.target.closest('tr');
            const id = tr.dataset.id;
            const customer = allCustomersRaw.find(c => c.id === id);
            if (customer) handleDelete(customer);
        });
    });
}

async function handleSaveCustomer(e) {
    e.preventDefault();

    const btnSave = document.getElementById('btn-save');
    const id = document.getElementById('customer-id').value;

    const customerData = {
        partyName: document.getElementById('cust-name').value.trim(),
        phone: document.getElementById('cust-phone').value.trim(),
        gstNumber: document.getElementById('cust-gst').value.trim() || null,
        shippingAddress: document.getElementById('cust-address').value.trim()
    };

    try {
        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';

        const custRef = collection(db, `users/${currentUser.uid}/customers`);

        if (id) {
            // Update
            const docRef = doc(db, `users/${currentUser.uid}/customers`, id);
            await updateDoc(docRef, {
                ...customerData,
                updatedAt: serverTimestamp()
            });
            showToast("Customer updated successfully");
        } else {
            // Create
            await addDoc(custRef, {
                ...customerData,
                createdAt: serverTimestamp()
            });
            showToast("Customer added successfully");
        }

        closeModal();
        await fetchCustomers();

    } catch (error) {
        console.error("Error saving customer:", error);
        showToast("Error saving customer", "error");
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            Save Customer
        `;
    }
}

async function handleDelete(customer) {
    if (!confirm(`Are you sure you want to delete ${customer.partyName}? This might affect existing invoices.`)) {
        return;
    }

    // Check if invoices exist for this customer
    try {
        const invoicesRef = collection(db, `users/${currentUser.uid}/invoices`);
        const q = query(invoicesRef, where("customerId", "==", customer.id));
        const snaps = await getDocs(q);

        if (!snaps.empty) {
            showToast(`Cannot delete: Found ${snaps.size} invoice(s) linked to this customer.`, "error");
            return;
        }

        // Proceed with deletion
        const docRef = doc(db, `users/${currentUser.uid}/customers`, customer.id);
        await deleteDoc(docRef);
        showToast("Customer deleted successfully");
        await fetchCustomers();
    } catch (error) {
        console.error("Error deleting customer:", error);
        showToast("Error deleting customer", "error");
    }
}

// Utils
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Run init
initCustomers();
