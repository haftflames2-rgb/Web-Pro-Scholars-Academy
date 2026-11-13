(() => {
  const emailLine = document.getElementById("contactEmailLine");
  const form = document.getElementById("contactForm");
  const msg = document.getElementById("contactMsg");
  const cleanText = (value) => String(value || "").replace(/[<>&"']/g, "");

  async function loadContactInfo() {
    try {
      const r = await fetch("/api/public/contact-info", { credentials: "same-origin" });
      const d = await r.json();
      if (r.ok && d.email) {
        const email = cleanText(d.email);
        emailLine.textContent = "Support email: ";
        const a = document.createElement("a");
        a.href = "mailto:" + email;
        a.textContent = email;
        emailLine.appendChild(a);
      } else {
        emailLine.textContent = "Please use the form below to contact SMARTTEP ACADEMY.";
      }
    } catch (_) {
      emailLine.textContent = "Please use the form below to contact SMARTTEP ACADEMY.";
    }
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = "Sending…";
      try {
        const r = await fetch("/api/public/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: document.getElementById("contactName").value,
            email: document.getElementById("contactEmail").value,
            message: document.getElementById("contactMessage").value
          })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Unable to send message.");
        msg.textContent = "Your message has been received. SMARTTEP ACADEMY will review it.";
        form.reset();
      } catch (err) {
        msg.textContent = err.message || "Unable to send message. Please try again.";
      }
    });
  }

  loadContactInfo();
})();
