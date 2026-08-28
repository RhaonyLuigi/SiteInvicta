/* ============================================================
   script.js — Atlética Invicta
   Video Scroll-Scrub via GSAP ScrollTrigger + Reveal Animations
============================================================ */

document.addEventListener("DOMContentLoaded", () => {
    gsap.registerPlugin(ScrollTrigger);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ----------------------------------------------------------
    // 1. NAV HEADER: glass effect on scroll
    // ----------------------------------------------------------
    const header = document.getElementById("site-header");
    ScrollTrigger.create({
        start: "top -10",
        onEnter: () => header.classList.add("scrolled"),
        onLeaveBack: () => header.classList.remove("scrolled"),
    });

    // ----------------------------------------------------------
    // 2. VIDEO SCROLL SCRUB
    //    The section is made tall (spacer). The inner div is
    //    sticky. GSAP scrubs video.currentTime via ScrollTrigger.
    // ----------------------------------------------------------
    const video = document.getElementById("hero-video");
    const wrapper = document.getElementById("hero-pin-wrapper");
    const spacer = document.getElementById("hero-scroll-spacer");
    const scrollHint = document.getElementById("scroll-hint");

    if (video) {
        // Wait for video metadata so we know duration
        function initVideoScrub() {
            if (!video.duration || isNaN(video.duration)) return;

            const duration = video.duration; // seconds

            // Set spacer height: we give 90px of scroll per second of video
            // plus 100vh for the sticky section itself.
            const pxPerSecond = 100; // tune this to feel right
            spacer.style.height = `${duration * pxPerSecond}px`;

            // Create a progress object GSAP can tween
            const state = { t: 0 };

            // Make the video seek to t=0 immediately (no autoplay)
            video.pause();
            video.currentTime = 0;

            // Fade scroll hint out once user starts scrolling
            ScrollTrigger.create({
                trigger: wrapper,
                start: "top top",
                end: `+=${duration * pxPerSecond * 0.1}`,
                onUpdate: (self) => {
                    if (scrollHint) scrollHint.style.opacity = 1 - self.progress;
                },
            });

            let targetTime = 0;
            let isUpdatingVideo = false;

            function updateVideoTime() {
                if (Math.abs(video.currentTime - targetTime) > 0.015) {
                    video.currentTime = targetTime;
                }
                isUpdatingVideo = false;
            }

            // Main scrub: tween state.t from 0 → duration
            gsap.to(state, {
                t: duration,
                ease: "none",
                onUpdate: () => {
                    // Clamp to avoid seeking past end
                    targetTime = Math.min(Math.max(state.t, 0), duration - 0.001);
                    
                    if (!isUpdatingVideo) {
                        isUpdatingVideo = true;
                        requestAnimationFrame(updateVideoTime);
                    }

                    // Fade to black: starts at 70% progress, fully black at 100%
                    const progress = targetTime / duration;
                    const fadeStart = 0.70; // start fading at 70% of video
                    const overlay = document.getElementById("hero-end-overlay");
                    if (overlay) {
                        if (progress >= fadeStart) {
                            overlay.style.opacity = (progress - fadeStart) / (1 - fadeStart);
                        } else {
                            overlay.style.opacity = 0;
                        }
                    }
                },
                scrollTrigger: {
                    trigger: wrapper,
                    start: "top top",         // pin starts when section top hits viewport top
                    end: () => `+=${duration * pxPerSecond}`, // scroll distance = video duration * px rate
                    scrub: 0.5,               // Smooth out the scrubbing to avoid jitter
                    invalidateOnRefresh: true,
                },
            });
        }

        // Try when metadata available, or immediately if already loaded
        if (video.readyState >= 1) {
            initVideoScrub();
        } else {
            video.addEventListener("loadedmetadata", initVideoScrub, { once: true });
        }
    }

    // ----------------------------------------------------------
    // 3. SCROLL REVEAL for content sections
    // ----------------------------------------------------------
    if (!reduceMotion) {
        const revealEls = gsap.utils.toArray(".gs-reveal");

        revealEls.forEach((el) => {
            gsap.fromTo(
                el,
                { opacity: 0, y: 28 },
                {
                    opacity: 1,
                    y: 0,
                    duration: 0.75,
                    ease: "power3.out",
                    scrollTrigger: {
                        trigger: el,
                        start: "top 88%",
                        toggleActions: "play none none none",
                    },
                }
            );
        });
    }
});
