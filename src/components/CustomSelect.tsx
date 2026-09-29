'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

interface Option {
  label: string;
  value: string;
}

interface CustomSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const CustomSelect: React.FC<CustomSelectProps> = ({
  options,
  value,
  onChange,
  placeholder,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const selectedOption = options.find(option => option.value === value);

  const handleToggle = () => {
    setIsOpen(prev => !prev);
  };

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !buttonRef.current) {
      setDropdownPosition(null);
      return;
    }

    const calculatePosition = () => {
      const rect = buttonRef.current!.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom,
        left: rect.left,
        width: rect.width,
      });
    };

    calculatePosition();

    window.addEventListener('resize', calculatePosition);
    window.addEventListener('scroll', calculatePosition, true);

    return () => {
      window.removeEventListener('resize', calculatePosition);
      window.removeEventListener('scroll', calculatePosition, true);
    };
  }, [isOpen]);

  return (
    <div className={`relative ${className}`} ref={selectRef}>
      <button
        type="button"
        className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white/50 dark:bg-zinc-800/50 flex items-center justify-between"
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        ref={buttonRef}
      >
        <span>{selectedOption ? selectedOption.label : placeholder}</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && dropdownPosition && createPortal(
        <div
          className="fixed z-[9999] bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-lg max-h-60 overflow-y-auto"
          role="listbox"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`,
          }}
        >
          {options.map(option => (
            <div
              key={option.value}
              className={`px-3 py-2 cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm ${
                option.value === value ? 'bg-blue-100 dark:bg-blue-300' : ''
              }`}
              onClick={() => handleSelect(option.value)}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};

export default CustomSelect;