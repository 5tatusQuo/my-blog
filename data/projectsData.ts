interface Project {
  title: string
  description: string
  href?: string
  imgSrc?: string
}

const projectsData: Project[] = [
  {
    title: 'Personal Blog Platform',
    description: `A modern, responsive blog built with Next.js and Tailwind CSS. Features include 
    dark mode, search functionality, and MDX support for rich content creation.`,
    imgSrc: '/static/images/blog-platform.png',
    href: 'https://github.com/quo/my-blog',
  },
  {
    title: 'Task Management App',
    description: `A full-stack task management application with real-time updates, user authentication, 
    and collaborative features. Built with React, Node.js, and MongoDB.`,
    imgSrc: '/static/images/task-app.png',
    href: 'https://github.com/quo/task-manager',
  },
  {
    title: 'Weather Dashboard',
    description: `A beautiful weather dashboard that displays current conditions and forecasts. 
    Integrates with multiple weather APIs and features interactive charts and maps.`,
    imgSrc: '/static/images/weather-dashboard.png',
    href: 'https://github.com/quo/weather-dashboard',
  },
]

export default projectsData
