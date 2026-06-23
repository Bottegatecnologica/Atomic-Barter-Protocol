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
  const baseStyle = "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors"
  const variants = {
    default: "bg-blue-500 text-white hover:bg-blue-600",
    outline: "border border-blue-500 text-blue-500 hover:bg-blue-50",
    ghost: "hover:bg-gray-100"
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