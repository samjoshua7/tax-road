import { auth, db, onAuthStateChanged, collection, query, getDocs, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc, signOut, where, runTransaction } from './firebase-config.js';
import { loadComponents, showToast, formatCurrency, formatDate, setPageTitle } from './utils.js';

let currentUser = null;
let allInvoicesRaw = [];
let customersMap = {}; // id -> name mapping
let currentLineItems = []; // Array of objects matching Firestore schema

// DOM Elements
const tbody = document.getElementById('invoices-body');
const searchInput = document.getElementById('global-search');
const modal = document.getElementById('invoice-modal');
const form = document.getElementById('invoice-form');
const btnCreate = document.getElementById('btn-create-invoice');
const btnClose = document.getElementById('modal-close');
const btnCancel = document.getElementById('btn-cancel');
const modalTitle = document.getElementById('modal-title');
const btnAddItem = document.getElementById('btn-add-item');
const itemsContainer = document.getElementById('invoice-items-container');
const customerSelect = document.getElementById('inv-customer');

// Initialize
async function initInvoices() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        await loadComponents();
        setupNavigation();
        setupEventListeners();

        // Load profile and customers in parallel — customers must finish before fetchInvoices for the map to be ready
        await Promise.all([loadUserProfile(), loadCustomers()]);
        await fetchInvoices();
    });
}

function setupNavigation() {
    console.log('[TAX ROAD DEBUG] === SETUP NAVIGATION START ===');

    // Debug: Check sidebar in DOM
    const sidebar = document.getElementById('sidebar-container');
    console.log('[TAX ROAD DEBUG] Sidebar container exists:', !!sidebar);
    if (sidebar) {
        console.log('[TAX ROAD DEBUG] Sidebar innerHTML length:', sidebar.innerHTML.length);
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
    setPageTitle('Invoices');

    // CRITICAL: Debug logout button
    console.log('[TAX ROAD DEBUG] === SEARCHING FOR LOGOUT BUTTON ===');
    const logoutBtn = document.getElementById('logout-btn');
    console.log('[TAX ROAD DEBUG] Logout button found:', !!logoutBtn);

    if (logoutBtn) {
        console.log('[TAX ROAD DEBUG] ✓ Logout button FOUND - Adding click listener');
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
        console.error('[TAX ROAD DEBUG] Sidebar HTML search for "logout":',
            sidebar?.innerHTML?.includes('logout') ? '✓ FOUND' : '✗ NOT FOUND');
    }

    const searchInputInst = document.getElementById('global-search');
    if (searchInputInst) {
        searchInputInst.addEventListener('input', (e) => {
            console.log(`[TAX ROAD DEBUG] Searching invoices for: ${e.target.value}`);
            filterInvoices(e.target.value);
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

async function loadCustomers() {
    try {
        console.log('[TAX ROAD DEBUG] Loading customers into invoice form...');
        const q = query(collection(db, `users/${currentUser.uid}/customers`));
        const snaps = await getDocs(q);

        customersMap = {};
        customerSelect.innerHTML = '<option value="">Select Customer</option>';

        const sortedCustomers = [];
        snaps.forEach(snap => {
            const data = snap.data();
            customersMap[snap.id] = data.partyName;
            sortedCustomers.push({ id: snap.id, name: data.partyName });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${sortedCustomers.length} customers for invoice form`);

        sortedCustomers.sort((a, b) => a.name.localeCompare(b.name));

        sortedCustomers.forEach(c => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.name;
            customerSelect.appendChild(option);
        });
    } catch (e) {
        console.error("[TAX ROAD ERROR] Error loading customers", e);
    }
}

function setupEventListeners() {
    btnCreate.addEventListener('click', () => {
        openModal(null, "Auto-generated upon save");
    });
    btnClose.addEventListener('click', closeModal);
    btnCancel.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    form.addEventListener('submit', handleSaveInvoice);
    btnAddItem.addEventListener('click', () => {
        addLineItemUI();
    });

    // Setup delegation for deleting items and updating calculations
    itemsContainer.addEventListener('input', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
            calculateTotals();
        }
    });

    itemsContainer.addEventListener('click', (e) => {
        const btnDelete = e.target.closest('.btn-delete-item');
        if (btnDelete) {
            const row = btnDelete.closest('.line-item-row');
            if (row) {
                row.remove();
                calculateTotals();
            }
        }
    });
}

async function generateSafeInvoiceNumber() {
    console.log('[TAX ROAD DEBUG] Generating safe transaction-based invoice number...');
    const counterRef = doc(db, `users/${currentUser.uid}/counters/invoices`);
    let newSequence = 1;

    await runTransaction(db, async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        if (!counterDoc.exists()) {
            // First ever invoice
            transaction.set(counterRef, { currentCount: 1 });
            newSequence = 1;
        } else {
            const data = counterDoc.data();
            newSequence = (data.currentCount || 0) + 1;
            transaction.update(counterRef, { currentCount: newSequence });
        }
    });

    return `INV-${String(newSequence).padStart(4, '0')}`;
}

function openModal(invoice = null, prefilledNumber = '') {
    itemsContainer.innerHTML = ''; // Clear items

    if (invoice) {
        modalTitle.textContent = 'Edit Invoice';
        document.getElementById('invoice-id').value = invoice.id;
        document.getElementById('inv-customer').value = invoice.customerId;
        document.getElementById('inv-number').value = invoice.invoiceNumber;
        document.getElementById('inv-date').value = invoice.createdAt ? new Date(invoice.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        // Load existing items
        if (invoice.items && invoice.items.length > 0) {
            invoice.items.forEach(item => addLineItemUI(item));
        } else {
            addLineItemUI(); // At least one empty row
        }

    } else {
        modalTitle.textContent = 'Create Invoice';
        form.reset();
        document.getElementById('invoice-id').value = '';
        document.getElementById('inv-number').value = prefilledNumber;
        document.getElementById('inv-date').value = new Date().toISOString().split('T')[0];
        addLineItemUI(); // Start with one empty row
    }

    calculateTotals();
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    form.reset();
    itemsContainer.innerHTML = '';
}

function addLineItemUI(itemData = null) {
    const defaultItem = { name: '', quantity: 1, price: 0, gstPercent: 18 };
    const item = itemData || defaultItem;

    const div = document.createElement('div');
    div.className = 'line-item-row';

    div.innerHTML = `
        <div class="form-group" style="margin-bottom:0;">
            <input type="text" class="form-control item-name" placeholder="Item description" required value="${escapeHtml(item.name)}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <input type="number" class="form-control item-qty" min="0.01" step="0.01" placeholder="Qty" required value="${item.quantity}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <input type="number" class="form-control item-price" min="0" step="0.01" placeholder="Price" required value="${item.price}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <select class="form-control item-gst">
                <option value="0" ${item.gstPercent === 0 ? 'selected' : ''}>0%</option>
                <option value="5" ${item.gstPercent === 5 ? 'selected' : ''}>5%</option>
                <option value="12" ${item.gstPercent === 12 ? 'selected' : ''}>12%</option>
                <option value="18" ${item.gstPercent === 18 ? 'selected' : ''}>18%</option>
                <option value="28" ${item.gstPercent === 28 ? 'selected' : ''}>28%</option>
            </select>
        </div>
        <button type="button" class="btn btn-outline btn-delete-item" style="padding: 10px; border-color: var(--text-error); color: var(--text-error);">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
    `;

    itemsContainer.appendChild(div);
}

function calculateTotals() {
    let subtotal = 0;
    let gstAmount = 0;

    const rows = itemsContainer.querySelectorAll('.line-item-row');
    rows.forEach(row => {
        const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        const gstPct = parseFloat(row.querySelector('.item-gst').value) || 0;

        const lineVal = qty * price;
        const lineGst = lineVal * (gstPct / 100);

        subtotal += lineVal;
        gstAmount += lineGst;
    });

    const total = subtotal + gstAmount;

    document.getElementById('inv-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('inv-gst').textContent = formatCurrency(gstAmount);
    document.getElementById('inv-total').textContent = formatCurrency(total);

    return { subtotal, gstAmount, total };
}

async function fetchInvoices() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching invoices from Firestore...');

        // Show loading state
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-lg"><div class="loader mx-auto"></div><div class="text-muted mt-sm">Loading invoices...</div></td></tr>`;
            tbody.closest('.table-container').style.opacity = '0.7';
        }

        const invoicesRef = collection(db, `users/${currentUser.uid}/invoices`);
        const q = query(invoicesRef);
        const snaps = await getDocs(q);

        allInvoicesRaw = [];
        snaps.forEach(snap => {
            allInvoicesRaw.push({ id: snap.id, ...snap.data() });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${allInvoicesRaw.length} invoices`);

        // Sort by date desc
        allInvoicesRaw.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (tbody) tbody.closest('.table-container').style.opacity = '1';
        renderInvoices(allInvoicesRaw);
    } catch (error) {
        console.error("[TAX ROAD ERROR] Error fetching invoices:", error);
        showToast("Failed to load invoices.", "error");
        if (tbody) {
            tbody.closest('.table-container').style.opacity = '1';
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-error">Failed to load data</td></tr>`;
        }
    }
}

function filterInvoices(searchTerm) {
    if (!searchTerm) {
        renderInvoices(allInvoicesRaw);
        return;
    }

    const lowerTerm = searchTerm.toLowerCase();
    const filtered = allInvoicesRaw.filter(inv => {
        const custName = customersMap[inv.customerId] || '';
        return (inv.invoiceNumber && inv.invoiceNumber.toLowerCase().includes(lowerTerm)) ||
            (custName.toLowerCase().includes(lowerTerm));
    });

    renderInvoices(filtered);
}

function renderInvoices(dataList) {
    if (!tbody) return;

    if (dataList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-md">No invoices found.</td></tr>`;
        return;
    }

    let html = '';
    dataList.forEach(inv => {
        const custName = escapeHtml(customersMap[inv.customerId] || 'Unknown Customer');
        const statusClass = inv.status === 'Paid' ? 'badge-success' :
            inv.status === 'Partially Paid' ? 'badge-warning' : 'badge-error';
        const displayStatus = inv.status || 'Pending';

        html += `
            <tr data-id="${inv.id}">
                <td class="font-bold text-primary">${inv.invoiceNumber}</td>
                <td>${custName}</td>
                <td>${formatDate(inv.createdAt)}</td>
                <td class="font-bold">${formatCurrency(inv.total || 0)}</td>
                <td><span class="badge ${statusClass}">${displayStatus}</span></td>
                <td class="actions-cell">
                    <button class="btn btn-outline btn-edit" style="padding: 6px; border-color: var(--accent); color: var(--accent);" title="Edit" ${inv.status === 'Paid' ? 'disabled' : ''}>
                        <svg class="icon" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <!-- Receipt functionality hooked up later potentially -->
                    <button class="btn btn-outline btn-delete" style="padding: 6px; border-color: var(--text-error); color: var(--text-error);" title="Delete" ${inv.status !== 'Pending' && inv.status ? 'disabled' : ''}>
                        <svg class="icon" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;

    // Attach Edit/Delete
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tr = e.target.closest('tr');
            const id = tr.dataset.id;
            const invoice = allInvoicesRaw.find(i => i.id === id);
            if (invoice) openModal(invoice);
        });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tr = e.target.closest('tr');
            const id = tr.dataset.id;
            const invoice = allInvoicesRaw.find(i => i.id === id);
            if (invoice) handleDelete(invoice);
        });
    });
}

function gatherLineItems() {
    const items = [];
    const rows = itemsContainer.querySelectorAll('.line-item-row');

    rows.forEach(row => {
        const name = row.querySelector('.item-name').value.trim();
        const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        const gstPct = parseFloat(row.querySelector('.item-gst').value) || 0;

        if (name && qty > 0) {
            items.push({ name, quantity: qty, price, gstPercent: gstPct });
        }
    });

    return items;
}

async function handleSaveInvoice(e) {
    e.preventDefault();

    const customerId = document.getElementById('inv-customer').value;
    if (!customerId) {
        showToast("Please select a customer.", "error");
        return;
    }

    const items = gatherLineItems();
    if (items.length === 0) {
        showToast("Please add at least one line item.", "error");
        return;
    }

    const { subtotal, gstAmount, total } = calculateTotals();
    const btnSave = document.getElementById('btn-save');
    const id = document.getElementById('invoice-id').value;
    const invNumber = document.getElementById('inv-number').value;
    const invDateStr = document.getElementById('inv-date').value;

    const invoiceData = {
        customerId,
        items,
        subtotal,
        gstAmount,
        total,
        // Convert yyyy-mm-dd to ISO UTC for consistency, or store as string if parsing is needed
        createdAt: new Date(invDateStr).toISOString()
    };

    try {
        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';

        const invRef = collection(db, `users/${currentUser.uid}/invoices`);

        if (id) {
            // Update
            const existingInv = allInvoicesRaw.find(i => i.id === id);
            invoiceData.status = existingInv.status || 'Pending';
            invoiceData.invoiceNumber = existingInv.invoiceNumber; // Ensure number doesn't disappear

            const docRef = doc(db, `users/${currentUser.uid}/invoices`, id);
            await updateDoc(docRef, {
                ...invoiceData,
                updatedAt: serverTimestamp()
            });
            showToast("Invoice updated successfully");
        } else {
            // Create New - Lock transaction and assign number
            const finalInvNum = await generateSafeInvoiceNumber();
            invoiceData.status = 'Pending';
            invoiceData.invoiceNumber = finalInvNum;

            await addDoc(invRef, {
                ...invoiceData
            });
            showToast("Invoice created successfully");
        }

        closeModal();
        await fetchInvoices();

    } catch (error) {
        console.error("Error saving invoice:", error);
        showToast("Error saving invoice", "error");
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            Save Invoice
        `;
    }
}

async function handleDelete(invoice) {
    if (!confirm(`Are you sure you want to delete invoice ${invoice.invoiceNumber}? This action cannot be undone.`)) {
        return;
    }

    // CHECK RULE 2: Invoice cannot be deleted if receipts exist
    try {
        const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
        const q = query(receiptsRef, where("invoiceId", "==", invoice.id));
        const snaps = await getDocs(q);

        if (!snaps.empty) {
            showToast("Invoice cannot be deleted because receipts are linked.", "error");
            return;
        }

        // Proceed with deletion since receipt_count == 0
        const docRef = doc(db, `users/${currentUser.uid}/invoices`, invoice.id);
        await deleteDoc(docRef);
        showToast("Invoice deleted successfully");
        await fetchInvoices();
    } catch (error) {
        console.error("Error deleting invoice:", error);
        showToast("Error deleting invoice", "error");
    }
}

// Utils
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return typeof unsafe === 'string' ? unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;") : unsafe;
}

// Run init
initInvoices();
