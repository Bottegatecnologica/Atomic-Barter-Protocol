import React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost'
}

const Button = ({ 
  children, 
  variant = 'default', 
  className = '', 
  ...props 
}: ButtonProps) => {
  const baseStyle = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
  const variants = {
    default: "bg-amber-400 text-zinc-950 hover:bg-amber-300",
    outline: "border border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10",
    ghost: "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
  }

  return (
    <button 
      className={`${baseStyle} ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export default Button