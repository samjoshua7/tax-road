import { auth, db, onAuthStateChanged, doc, getDoc, setDoc, signOut } from './firebase-config.js';
import { loadComponents, showToast, setPageTitle } from './utils.js';

let currentUser = null;

async function initSettings() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;
        await loadComponents();
        setPageTitle('Settings');
        setupNavigation();
        setupForm();
        await loadProfile();
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

function setupForm() {
    const form = document.getElementById('settings-form');
    const btnCancel = document.getElementById('btn-cancel');

    if (btnCancel) btnCancel.addEventListener('click', () => {
        window.history.back();
    });

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveProfile();
        });
    }
}

async function loadProfile() {
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
            const data = snap.data();
            document.getElementById('businessName').value = data.businessName || '';
            document.getElementById('gstNumber').value = data.gstNumber || '';
            document.getElementById('upiId').value = data.upiId || '';
            document.getElementById('phone').value = data.phone || '';

            // Also update topnav display if loaded
            const nameDisplay = document.getElementById('user-display-name');
            if (nameDisplay && data.businessName) {
                nameDisplay.textContent = data.businessName;
                nameDisplay.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('[TAX ROAD] Error loading profile:', error);
        showToast('Failed to load profile', 'error');
    }
}

async function saveProfile() {
    const saveBtn = document.getElementById('btn-save');
    try {
        const businessName = document.getElementById('businessName').value.trim();
        const gstNumber = document.getElementById('gstNumber').value.trim();
        const upiId = document.getElementById('upiId').value.trim();
        const phone = document.getElementById('phone').value.trim();

        if (!businessName) {
            showToast('Business name is required', 'error');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        const userRef = doc(db, 'users', currentUser.uid);
        await setDoc(userRef, {
            businessName: businessName,
            gstNumber: gstNumber || null,
            upiId: upiId || null,
            phone: phone || null,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        // Update topnav display immediately
        const nameDisplay = document.getElementById('user-display-name');
        if (nameDisplay) {
            nameDisplay.textContent = businessName;
            nameDisplay.style.display = 'block';
        }

        showToast('Profile updated successfully');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    } catch (error) {
        console.error('[TAX ROAD] Error saving profile:', error);
        showToast('Failed to save profile', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

// Initialize
initSettings();
