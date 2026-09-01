// WPS Academy Authentication

const message = document.getElementById("msg");

// LOGIN
const loginForm = document.getElementById("loginForm");

if (loginForm) {
    loginForm.addEventListener("submit", async function (event) {
        event.preventDefault();

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        if (!email || !password) {
            message.textContent = "Please enter your email and password.";
            return;
        }

        try {
            const response = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                message.textContent = data.error || "Login failed.";
                return;
            }

            window.location.href = data.redirect || "/index.html";

        } catch (error) {
            console.error(error);
            message.textContent = "Unable to connect to the server.";
        }
    });
}

// REGISTRATION
const registerForm = document.getElementById("registerForm");

if (registerForm) {
    registerForm.addEventListener("submit", async function (event) {
        event.preventDefault();

        const name = document.getElementById("name").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const confirmPassword = document.getElementById("confirm").value;

        if (!name || !email || !password || !confirmPassword) {
            message.textContent = "Please fill in all fields.";
            return;
        }

        if (password.length < 8) {
            message.textContent =
                "Password must contain at least 8 characters.";
            return;
        }

        if (password !== confirmPassword) {
            message.textContent = "Passwords do not match.";
            return;
        }

        try {
            const response = await fetch("/api/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                message.textContent =
                    data.error || "Registration failed.";
                return;
            }

            // Successful registration -> payment portal
            window.location.href =
                data.redirect || "/payment.html";

        } catch (error) {
            console.error(error);
            message.textContent =
                "Unable to connect to the server.";
        }
    });
}
