// GitHub Pages preserva o endereço antigo. A aplicação e a API vivem na Vercel.
if (location.hostname === "rhaonyluigi.github.io") {
    const prefix = "/SiteInvicta";
    if (location.pathname === prefix || location.pathname.startsWith(prefix + "/")) {
        location.replace("https://site-invicta.vercel.app" + (location.pathname.slice(prefix.length) || "/") + location.search + location.hash);
    }
}
