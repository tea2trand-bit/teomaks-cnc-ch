const monthNamesByLang = {
  de: ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"],
  en: ["January","February","March","April","May","June","July","August","September","October","November","December"]
};
function monthNamesFor(){
  return monthNamesByLang[window.__lang === "en" ? "en" : "de"];
}
let booked = new Set();
let rangeStart = "";
let rangeEnd = "";
let view = new Date();
view.setDate(1);

async function loadAvailability(){
  try{
    const res = await fetch("/.netlify/functions/availability").catch(() => fetch("availability.json"));
    const data = await res.json();
    booked = new Set(data.booked || []);
  }catch(e){
    booked = new Set();
  }
  renderCalendar();
}
function isoDate(y,m,d){ return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
function renderCalendar(){
  const title = document.getElementById("monthTitle");
  const days = document.getElementById("calendarDays");
  const y = view.getFullYear(), m = view.getMonth();
  title.textContent = `${monthNamesFor()[m]} ${y}`;
  days.innerHTML = "";
  const first = new Date(y,m,1);
  const startOffset = (first.getDay()+6)%7;
  const lastDay = new Date(y,m+1,0).getDate();
  for(let i=0;i<startOffset;i++){
    const el=document.createElement("span");
    el.className="day muted";
    days.appendChild(el);
  }
  const now = new Date();
  for(let d=1; d<=lastDay; d++){
    const key = isoDate(y,m,d);
    const isBusy = booked.has(key);
    const el=document.createElement("span");
    el.className = "day" + (isBusy ? " busy" : " is-free");
    if(now.getFullYear()===y && now.getMonth()===m && now.getDate()===d) el.className += " today";
    if(!isBusy && rangeStart){
      if(key === rangeStart) el.className += " is-range-start";
      if(rangeEnd && key === rangeEnd) el.className += " is-range-end";
      if(rangeEnd && key > rangeStart && key < rangeEnd) el.className += " is-in-range";
    }
    el.textContent=d;
    if(!isBusy){
      el.setAttribute("role","button");
      el.setAttribute("tabindex","0");
      el.addEventListener("click", () => selectDay(key));
      el.addEventListener("keydown", (e) => {
        if(e.key === "Enter" || e.key === " "){ e.preventDefault(); selectDay(key); }
      });
    }
    days.appendChild(el);
  }
}
// Let visitors pick a period in the calendar with a "Von" (from) and "Bis" (to)
// day. A single click selects one day; a second click on a later (or earlier)
// day completes the range. The selection is mirrored into the contact form's
// "Gewünschter Zeitraum" field so the visitor never has to type a date twice.
function formatDE(iso){
  const [y,m,d] = iso.split("-");
  return `${d}.${m}.${y}`;
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
  renderCalendar();
}
function syncRange(){
  const input = document.querySelector('.contact-form input[name="termin"]');
  const summary = document.getElementById("rangeSummary");
  const fromEl = document.getElementById("rangeFrom");
  const toEl = document.getElementById("rangeTo");
  const resetBtn = document.getElementById("rangeReset");

  let value = "";
  if(rangeStart && rangeEnd && rangeEnd !== rangeStart){
    value = `${formatDE(rangeStart)} – ${formatDE(rangeEnd)}`;
  } else if(rangeStart){
    value = formatDE(rangeStart);
  }
  if(input) input.value = value;

  const hasSelection = Boolean(rangeStart);
  if(summary) summary.hidden = !hasSelection;
  if(resetBtn) resetBtn.hidden = !hasSelection;
  if(fromEl) fromEl.textContent = rangeStart ? formatDE(rangeStart) : "–";
  if(toEl) toEl.textContent = rangeEnd ? formatDE(rangeEnd) : (rangeStart ? formatDE(rangeStart) : "–");
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
        photo.setAttribute("role", "img");
        photo.setAttribute("aria-label", firstImage.alt || project.title || "Projektbild");
        photo.style.backgroundImage = `linear-gradient(rgba(5,12,22,.06),rgba(5,12,22,.24)),url("${firstImage.url}")`;
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

// V7 mobile menu
const menuToggle = document.getElementById("menuToggle");
const siteNav = document.getElementById("siteNav");
if(menuToggle && siteNav){
  menuToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });
  siteNav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
      siteNav.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
    });
  });
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


// V25 mobile navigation
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".nav, .main-nav, .modern-nav, .site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("nav-open");
      toggle.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        nav.classList.remove("nav-open");
        toggle.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }
});


// V29 hamburger menu
document.addEventListener("DOMContentLoaded", () => {
  const menuToggle = document.getElementById("menuToggle");
  const siteNav = document.getElementById("siteNav");

  if (menuToggle && siteNav) {
    menuToggle.addEventListener("click", () => {
      const isOpen = siteNav.classList.toggle("is-open");
      menuToggle.classList.toggle("is-open", isOpen);
      menuToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        siteNav.classList.remove("is-open");
        menuToggle.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
  }
});


// V32 hamburger
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("menuToggle");
  const nav = document.getElementById("siteNav");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    btn.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll("a").forEach(a => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      btn.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
    });
  });
});
