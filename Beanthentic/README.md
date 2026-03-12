# Beanthentic Coffee Website

A clean, modern coffee website with organized, modular frontend structure.

## Project Structure

```
Beanthentic/
├── index.html              # Main HTML file with component loading
├── css/                    # Stylesheets organized by function
│   ├── base.css           # Base styles, reset, typography
│   ├── layout.css         # Header, footer, navigation layout
│   ├── components.css     # Hero, about, and other component styles
│   └── responsive.css     # Mobile and responsive styles
├── js/                     # JavaScript files organized by functionality
│   ├── main.js            # Main application entry point
│   ├── navigation.js      # Navigation and smooth scrolling
│   └── ui.js              # UI interactions and animations
├── components/             # HTML component templates
│   ├── header.html        # Header and navigation
│   ├── hero.html          # Hero section
│   ├── about.html         # About section
│   └── footer.html        # Footer
├── assets/                 # Static assets
│   └── images/            # Image files
│       └── logo.png       # Company logo
└── README.md              # This file
```

## Features

- **Modular Architecture**: Separated CSS, JavaScript, and HTML components for better maintainability
- **Responsive Design**: Mobile-first approach with responsive breakpoints
- **Smooth Animations**: CSS animations and JavaScript-powered interactions
- **Component-Based**: Reusable HTML components loaded dynamically
- **Modern JavaScript**: ES6+ features with clean class-based organization

## Getting Started

1. Open `index.html` in a web browser
2. The components will be loaded automatically via JavaScript
3. All styles and scripts are modular and can be easily extended

## File Organization

### CSS Files
- `base.css`: Global styles, resets, typography, and basic button styles
- `layout.css`: Header, navigation, footer, and main layout components
- `components.css`: Specific component styles (hero, about, cards)
- `responsive.css`: Media queries and responsive design rules

### JavaScript Files
- `main.js`: Application initialization and global utilities
- `navigation.js`: Smooth scrolling, active navigation highlighting
- `ui.js`: UI interactions, animations, and user experience enhancements

### HTML Components
- Each component is a separate HTML file for easy maintenance
- Components are loaded dynamically into the main index.html
- This approach allows for better code organization and reusability

## Development

The codebase follows modern web development best practices:
- Semantic HTML5 markup
- CSS with logical organization and clear naming conventions
- Modular JavaScript with class-based architecture
- Responsive design with mobile-first approach
- Accessibility considerations

## Browser Support

Modern browsers that support:
- ES6+ JavaScript features
- CSS Grid and Flexbox
- CSS custom properties (variables)
- Intersection Observer API