const toolConfig = {
  reels: {
    label: "INSTAGRAM REELS",
    title: "Reels Downloader",
    description: "Keep videos you created or have permission to save.",
    placeholder: "https://www.instagram.com/reel/...",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="m10 8.5 6 3.5-6 3.5z"/></svg>',
    matches: path => /\/reel\//i.test(path)
  },
  stories: {
    label: "INSTAGRAM STORIES",
    title: "Story Downloader",
    description: "Access stories through an account that has authorized InstaFetch.",
    placeholder: "https://www.instagram.com/stories/username/...",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 2.8h6M21.2 9v6M9 21.2h6M2.8 9v6"/></svg>',
    matches: path => /\/stories\//i.test(path)
  },
  posts: {
    label: "INSTAGRAM POSTS",
    title: "Posts Downloader",
    description: "Save supported photos and videos you are allowed to access.",
    placeholder: "https://www.instagram.com/p/...",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4.5 17 5-5 3.5 3 2.5-2 4 4"/></svg>',
    matches: path => /\/(p|tv)\//i.test(path)
  },
  profile: {
    label: "INSTAGRAM PROFILE",
    title: "Profile Picture Downloader",
    description: "View profile images available through supported account access.",
    placeholder: "https://www.instagram.com/username/",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.4 3.1-5.2 7-5.2s6.3 1.8 7 5.2"/></svg>',
    matches: path => /^\/[a-z0-9._]+\/?$/i.test(path)
  }
};

const tabs = [...document.querySelectorAll(".tool-tab")];
const input = document.getElementById("instagram-url");
const message = document.getElementById("form-message");
const form = document.getElementById("download-form");
let selectedType = "reels";

function showMessage(text, state = "") {
  message.textContent = text;
  message.classList.remove("error", "success");
  if (state) message.classList.add(state);
}

function chooseTool(type) {
  const config = toolConfig[type];
  if (!config) return;
  selectedType = type;
  tabs.forEach(tab => {
    const active = tab.dataset.type === type;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.getElementById("tool-kicker").textContent = config.label;
  document.getElementById("tool-title").textContent = config.title;
  document.getElementById("tool-description").textContent = config.description;
  document.getElementById("active-icon").innerHTML = config.icon;
  input.placeholder = config.placeholder;
  input.value = "";
  showMessage("Only submit content you own or have permission to access.");
}

tabs.forEach(tab => tab.addEventListener("click", () => chooseTool(tab.dataset.type)));

document.getElementById("paste-button").addEventListener("click", async () => {
  try {
    const pasted = await navigator.clipboard.readText();
    if (!pasted.trim()) {
      showMessage("Your clipboard is empty.");
      return;
    }
    input.value = pasted.trim();
    showMessage("Link pasted. Check it, then continue.", "success");
  } catch {
    showMessage("Clipboard access is unavailable. Paste your link into the field.");
    input.focus();
  }
});

form.addEventListener("submit", event => {
  event.preventDefault();
  let url;
  try {
    url = new URL(input.value.trim());
  } catch {
    showMessage("Enter a valid Instagram link to continue.", "error");
    input.focus();
    return;
  }

  const hostname = url.hostname.toLowerCase();
  const isInstagram = hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  if (!isInstagram || !toolConfig[selectedType].matches(url.pathname)) {
    showMessage("That link does not match the selected tool. Check the link and try again.", "error");
    return;
  }

  showMessage("Link format verified. Meta authorization and supported media access will be connected in the next setup stage.", "success");
});

document.getElementById("year").textContent = new Date().getFullYear();