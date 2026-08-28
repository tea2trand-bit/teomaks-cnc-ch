const monthNamesByLang = {
  de: ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"],
  en: ["January","February","March","April","May","June","July","August","September","October","November","December"]
};
function monthNamesFor(){
  return monthNamesByLang[window.__lang === "en" ? "en" : "de"];
}
let booked = new Set();
let availabilityState = "loading";
let rangeStart = "";
let rangeEnd = "";
let view = new Date();
view.setDate(1);

async function loadAvailability(){
  availabilityState = "loading";
  renderCalendar();
  try{
    const res = await fetch("/.netlify/functions/availability");
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if(!data || !Array.isArray(data.booked) || !data.booked.every(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))){
      throw new Error("Invalid availability response");
    }
    booked = new Set(data.booked);
    availabilityState = "ready";
  }catch(e){
    booked = new Set();
    availabilityState = "error";
  }
  renderCalendar();
}
function isoDate(y,m,d){ return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
function renderCalendar(focusKey = ""){
  const title = document.getElementById("monthTitle");
  const days = document.getElementById("calendarDays");
  const y = view.getFullYear(), m = view.getMonth();
  title.textContent = `${monthNamesFor()[m]} ${y}`;
  days.innerHTML = "";
  if(availabilityState !== "ready"){
    const english = window.__lang === "en";
    title.textContent = availabilityState === "loading"
      ? (english ? "Loading availability…" : "Verfügbarkeit wird geladen…")
      : (english ? "Availability is currently unavailable" : "Verfügbarkeit ist derzeit nicht verfügbar");
    days.setAttribute("aria-busy", availabilityState === "loading" ? "true" : "false");
    return;
  }
  days.removeAttribute("aria-busy");
  const first = new Date(y,m,1);
  const startOffset = (first.getDay()+6)%7;
  const lastDay = new Date(y,m+1,0).getDate();
  for(let i=0;i<startOffset;i++){
    const el=document.createElement("span");
    el.className="day muted";
    days.appendChild(el);
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const english = window.__lang === "en";
  const locale = english ? "en-GB" : "de-CH";
  for(let d=1; d<=lastDay; d++){
    const key = isoDate(y,m,d);
    const isBusy = booked.has(key);
    const date = new Date(y,m,d);
    const isPast = date < today;
    const isSelected = Boolean(rangeStart) && (!rangeEnd ? key === rangeStart : key >= rangeStart && key <= rangeEnd);
    const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(date);
    const el=document.createElement("span");
    el.className = "day" + (isPast ? " past" : (isBusy ? " busy" : " is-free"));
    el.dataset.date = key;
    if(now.getFullYear()===y && now.getMonth()===m && now.getDate()===d) el.className += " today";
    if(!isBusy && rangeStart){
      if(key === rangeStart) el.className += " is-range-start";
      if(rangeEnd && key === rangeEnd) el.className += " is-range-end";
      if(rangeEnd && key > rangeStart && key < rangeEnd) el.className += " is-in-range";
    }
    el.textContent=d;
    if(now.getFullYear()===y && now.getMonth()===m && now.getDate()===d) el.setAttribute("aria-current", "date");
    if(!isBusy && !isPast){
      el.setAttribute("role","button");
      el.setAttribute("tabindex","0");
      el.setAttribute("aria-pressed", isSelected ? "true" : "false");
      el.setAttribute("aria-label", `${fullDate}, ${isSelected ? (english ? "selected" : "ausgewählt") : (english ? "available" : "verfügbar")}`);
      el.addEventListener("click", () => selectDay(key));
      el.addEventListener("keydown", (e) => {
        if(e.key === "Enter" || e.key === " "){ e.preventDefault(); selectDay(key); }
      });
    } else {
      el.setAttribute("role", "button");
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("aria-label", `${fullDate}, ${isPast ? (english ? "past date" : "vergangener Termin") : (english ? "booked" : "ausgebucht")}`);
    }
    days.appendChild(el);
  }
  if(focusKey){
    const target = days.querySelector(`[data-date="${focusKey}"]`);
    if(target) target.focus();
  }
}
window.renderCalendar = renderCalendar;
// Let visitors pick a period in the calendar with a "Von" (from) and "Bis" (to)
// day. A single click selects one day; a second click on a later (or earlier)
// day completes the range. The selection is mirrored into the contact form's
// "Gewünschter Zeitraum" field so the visitor never has to type a date twice.
function formatDate(iso){
  const [y,m,d] = iso.split("-");
  return new Intl.DateTimeFormat(window.__lang === "en" ? "en-GB" : "de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(Number(y), Number(m) - 1, Number(d)));
}
function selectDay(key){
  if(!rangeStart || (rangeStart && rangeEnd)){
    // Start a fresh selection.
    rangeStart = key;
    rangeEnd = "";
  } else if(key > rangeStart){
    rangeEnd = key;
  } else if(key < rangeStart){
    // Clicked an earlier day: it becomes the new "Von", old start the "Bis".
    rangeEnd = rangeStart;
    rangeStart = key;
  } else {
    // Same day clicked again → keep it as a single day.
    rangeEnd = "";
  }
  syncRange();
  renderCalendar(key);
}
function syncRange(){
  const input = document.querySelector('.contact-form input[name="termin"]');
  const summary = document.getElementById("rangeSummary");
  const fromEl = document.getElementById("rangeFrom");
  const toEl = document.getElementById("rangeTo");
  const resetBtn = document.getElementById("rangeReset");

  let value = "";
  if(rangeStart && rangeEnd && rangeEnd !== rangeStart){
    value = `${formatDate(rangeStart)} – ${formatDate(rangeEnd)}`;
  } else if(rangeStart){
    value = formatDate(rangeStart);
  }
  if(input) input.value = value;

  const hasSelection = Boolean(rangeStart);
  if(summary) summary.hidden = !hasSelection;
  if(resetBtn) resetBtn.hidden = !hasSelection;
  if(fromEl) fromEl.textContent = rangeStart ? formatDate(rangeStart) : "–";
  if(toEl) toEl.textContent = rangeEnd ? formatDate(rangeEnd) : (rangeStart ? formatDate(rangeStart) : "–");
}
function clearRange(){
  rangeStart = "";
  rangeEnd = "";
  syncRange();
  renderCalendar();
}
document.getElementById("prevMonth").addEventListener("click",()=>{view.setMonth(view.getMonth()-1);renderCalendar();});
document.getElementById("nextMonth").addEventListener("click",()=>{view.setMonth(view.getMonth()+1);renderCalendar();});
const rangeResetBtn = document.getElementById("rangeReset");
if(rangeResetBtn){
  rangeResetBtn.addEventListener("click", clearRange);
}
// Clear the calendar highlight when the form is reset after a successful send.
const contactForm = document.querySelector('form[name="contact"]');
if(contactForm){
  contactForm.addEventListener("reset", () => { rangeStart = ""; rangeEnd = ""; syncRange(); renderCalendar(); });
}
loadAvailability();

// Load the customer / reference logos for the "Unsere Kunden" section from the
// admin-managed source. This lets the site owner add or remove reference
// customers entirely through the admin panel, with no code change. The two
// logos already in the markup act as a fallback and are only replaced once at
// least one active logo has been configured in the admin area.
async function loadClientLogos(){
  const container = document.getElementById("clientsLogos");
  if(!container) return;
  try{
    const res = await fetch("/.netlify/functions/customer-logos");
    if(!res.ok) return;
    const data = await res.json();
    const logos = Array.isArray(data.logos) ? data.logos : [];
    if(!logos.length) return; // keep the static fallback logos
    container.innerHTML = "";
    logos.forEach(logo => {
      const cell = document.createElement("div");
      cell.className = "logo-cell";
      const img = document.createElement("img");
      img.className = "client-logo client-logo--dynamic";
      img.src = logo.url;
      img.loading = "lazy";
      img.alt = "Kundenlogo";
      cell.appendChild(img);
      container.appendChild(cell);
    });
  }catch(e){
    // Network/parse error → leave the static fallback logos in place.
  }
}
loadClientLogos();

async function loadCompletedProjects(){
  const container = document.getElementById("completedProjects");
  if(!container) return;
  function renderEmptyProjects(){
    container.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "project-empty";
    empty.textContent = "Aktuell sind keine abgeschlossenen Projekte veröffentlicht.";
    container.appendChild(empty);
  }
  try{
    const res = await fetch("/.netlify/functions/completed-projects");
    if(!res.ok){
      renderEmptyProjects();
      return;
    }
    const data = await res.json();
    const projects = Array.isArray(data.projects) ? data.projects : [];
    if(!projects.length){
      renderEmptyProjects();
      return;
    }
    container.innerHTML = "";
    projects.forEach(project => {
      const article = document.createElement("article");
      article.className = "project-card";

      const firstImage = project.images && project.images[0];
      if(firstImage && firstImage.url){
        const photo = document.createElement("div");
        photo.className = "project-photo";
        const image = document.createElement("img");
        image.src = firstImage.url;
        image.alt = firstImage.alt || project.title || "Projektbild";
        image.loading = "lazy";
        image.decoding = "async";
        photo.appendChild(image);
        article.appendChild(photo);
      }

      const title = document.createElement("h3");
      title.textContent = project.title || "";
      article.appendChild(title);

      const summary = document.createElement("p");
      summary.textContent = project.summary || "";
      article.appendChild(summary);

      if(project.description && project.description !== project.summary){
        const description = document.createElement("p");
        description.className = "project-description";
        description.textContent = project.description;
        article.appendChild(description);
      }

      const facts = [project.date, project.location, project.customer].filter(Boolean);
      if(facts.length){
        const meta = document.createElement("div");
        meta.className = "project-meta";
        meta.textContent = facts.join(" · ");
        article.appendChild(meta);
      }
      container.appendChild(article);
    });
  }catch(e){
    renderEmptyProjects();
  }
}
loadCompletedProjects();

function initMobileMenu(){
  const menuToggle = document.getElementById("menuToggle");
  const siteNav = document.getElementById("siteNav");
  if(!menuToggle || !siteNav) return;

  const setOpen = (open) => {
    siteNav.classList.toggle("is-open", open);
    menuToggle.classList.toggle("is-open", open);
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  menuToggle.addEventListener("click", (event) => {
    event.preventDefault();
    setOpen(!siteNav.classList.contains("is-open"));
  });

  siteNav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => setOpen(false));
  });
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", initMobileMenu);
}else{
  initMobileMenu();
}

// V7 cookie notice
const cookieBanner = document.getElementById("cookieBanner");
const acceptCookies = document.getElementById("acceptCookies");
if(cookieBanner && acceptCookies){
  if(localStorage.getItem("teomaksCookieNotice") !== "accepted"){
    cookieBanner.classList.add("show");
  }
  acceptCookies.addEventListener("click", () => {
    localStorage.setItem("teomaksCookieNotice", "accepted");
    cookieBanner.classList.remove("show");
  });
}


// V24 cookie close button
const cookieClose = document.getElementById("cookieClose");
if(cookieBanner && cookieClose){
  cookieClose.addEventListener("click", () => {
    cookieBanner.classList.remove("show");
  });
}
