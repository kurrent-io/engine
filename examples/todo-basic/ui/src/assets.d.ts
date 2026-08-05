declare module '*.png' {
  const value: string;
  export default value;
}

// we only import style.css for side-effects, so no additional typing is needed here
declare module '*.css';
