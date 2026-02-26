import {
    auth,
    db,
    googleProvider,
    signInWithPopup,
    onAuthStateChanged,
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from './firebase-config.js';

// DOM Elements
const loginBtn = document.getElementById('google-login-btn');
const loginContainer = document.getElementById('login-container');
const onboardingContainer = document.getElementById('onboarding-container');
const onboardingForm = document.getElementById('onboarding-form');
const loginError = document.getElementById('login-error');
const onboardingError = document.getElementById('onboarding-error');
const loginLoader = document.getElementById('login-loader');

let currentUser = null;

// Initialize Auth
export function initAuth() {
    // Check if we are on the login page
    const isLoginPage = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            // Check if user has a profile in Firestore
            try {
                const userDocRef = doc(db, 'users', user.uid);
                const userDocSnap = await getDoc(userDocRef);

                if (userDocSnap.exists()) {
                    // User profile exists, redirect to dashboard if on login page
                    if (isLoginPage) {
                        window.location.href = 'dashboard.html';
                    }
                } else {
                    // User profile does not exist, show onboarding if on login page
                    if (isLoginPage) {
                        showOnboarding();
                    } else {
                        // If not on login page and no profile, force back to login
                        window.location.href = 'index.html';
                    }
                }
            } catch (error) {
                console.error("Error checking user profile:", error);
                if (isLoginPage) showError("Error verifying account. Please try again.");
            }
        } else {
            currentUser = null;
            // No user is signed in, redirect to login if not already there
            if (!isLoginPage) {
                window.location.href = 'index.html';
            }
        }
    });

    // Setup event listeners if on login page
    if (isLoginPage && loginBtn) {
        loginBtn.addEventListener('click', handleGoogleLogin);
    }

    if (isLoginPage && onboardingForm) {
        onboardingForm.addEventListener('submit', handleOnboardingSubmit);
    }
}

async function handleGoogleLogin() {
    hideError();
    showLoader();

    try {
        await signInWithPopup(auth, googleProvider);
        // onAuthStateChanged will handle the rest
    } catch (error) {
        console.error("Login failed:", error);
        hideLoader();
        showError(error.message || "Failed to sign in. Please try again.");
    }
}

async function handleOnboardingSubmit(e) {
    e.preventDefault();

    if (!currentUser) return;

    const businessName = document.getElementById('business-name').value.trim();
    const gstNumber = document.getElementById('gst-number').value.trim();
    const saveBtn = document.getElementById('save-profile-btn');

    if (!businessName) {
        showOnboardingError("Business name is required.");
        return;
    }

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        // Create user profile in Firestore
        await setDoc(doc(db, 'users', currentUser.uid), {
            businessName: businessName,
            gstNumber: gstNumber || null,
            email: currentUser.email,
            createdAt: serverTimestamp()
        });

        // Redirect to dashboard
        window.location.href = 'dashboard.html';
    } catch (error) {
        console.error("Error saving profile:", error);
        showOnboardingError("Failed to save profile. Please try again.");
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Profile';
    }
}

// UI Helpers for Login Page
function showLoader() {
    if (loginBtn) loginBtn.classList.add('hidden');
    if (loginLoader) loginLoader.classList.remove('hidden');
}

function hideLoader() {
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (loginLoader) loginLoader.classList.add('hidden');
}

function showError(msg) {
    if (loginError) {
        loginError.textContent = msg;
        loginError.classList.remove('hidden');
    }
}

function hideError() {
    if (loginError) loginError.classList.add('hidden');
}

function showOnboardingError(msg) {
    if (onboardingError) {
        onboardingError.textContent = msg;
        onboardingError.classList.remove('hidden');
    }
}

function showOnboarding() {
    if (loginContainer) loginContainer.classList.add('hidden');
    if (onboardingContainer) onboardingContainer.classList.remove('hidden');
    hideLoader();
}

// Run init on load
initAuth();
