// get the ninja-keys element
const ninja = document.querySelector('ninja-keys');

// add the home and posts menu items
ninja.data = [{
    id: "nav-about",
    title: "about",
    section: "Navigation",
    handler: () => {
      window.location.href = "/";
    },
  },{id: "nav-publications",
          title: "publications",
          description: "",
          section: "Navigation",
          handler: () => {
            window.location.href = "/publications/";
          },
        },{id: "books-the-godfather",
          title: 'The Godfather',
          description: "",
          section: "Books",handler: () => {
              window.location.href = "/books/the_godfather.html";
            },},{id: "news-started-undergraduate-research-internship-at-effl-lab-postech",
          title: 'Started undergraduate research internship at EFFL Lab, POSTECH.',
          description: "",
          section: "News",},{id: "news-started-undergraduate-research-internship-at-edgeai-lab-yonsei-university",
          title: 'Started undergraduate research internship at EdgeAI Lab, Yonsei University.',
          description: "",
          section: "News",},{id: "news-i-will-be-joining-the-school-of-computing-at-kaist-as-an-incoming-master-s-student-in-the-2026-fall-semester",
          title: 'I will be joining the School of Computing at KAIST as an incoming...',
          description: "",
          section: "News",},{id: "projects-pathos",
          title: 'PathOs',
          description: "Pathology Optimal Efficient Segmentation Tool Based on Human-in-the-loop Strategy",
          section: "Projects",handler: () => {
              window.location.href = "/projects/example_project.html";
            },},{
        id: 'social-cv',
        title: 'CV',
        section: 'Socials',
        handler: () => {
          window.open("https://docs.google.com/document/d/1u5ZOumfnOU6sw_Ljsl99DYPOpv1tkxqGdI3NeTzM4X0/edit?usp=sharing", "_blank");
        },
      },{
        id: 'social-email',
        title: 'email',
        section: 'Socials',
        handler: () => {
          window.open("mailto:%68%61%6E.%6A%75%6E%67@%6B%61%69%73%74.%61%63.%6B%72", "_blank");
        },
      },{
        id: 'social-linkedin',
        title: 'LinkedIn',
        section: 'Socials',
        handler: () => {
          window.open("https://www.linkedin.com/in/hkjung1123", "_blank");
        },
      },{
        id: 'social-scholar',
        title: 'Google Scholar',
        section: 'Socials',
        handler: () => {
          window.open("https://scholar.google.com/citations?user=yGVBIPUAAAAJ", "_blank");
        },
      },{
        id: 'social-custom_social',
        title: 'Custom_social',
        section: 'Socials',
        handler: () => {
          window.open("https://kmuhan-study.tistory.com/", "_blank");
        },
      },{
      id: 'light-theme',
      title: 'Change theme to light',
      description: 'Change the theme of the site to Light',
      section: 'Theme',
      handler: () => {
        setThemeSetting("light");
      },
    },
    {
      id: 'dark-theme',
      title: 'Change theme to dark',
      description: 'Change the theme of the site to Dark',
      section: 'Theme',
      handler: () => {
        setThemeSetting("dark");
      },
    },
    {
      id: 'system-theme',
      title: 'Use system default theme',
      description: 'Change the theme of the site to System Default',
      section: 'Theme',
      handler: () => {
        setThemeSetting("system");
      },
    },];
