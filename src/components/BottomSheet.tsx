import React, { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import { XIcon } from './icons';
import { SIDE_INSET_LEFT, SIDE_INSET_RIGHT } from './layout/chromeOffsets';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  height?: 'auto' | 'full' | 'half' | number;
  showHandle?: boolean;
  closeOnOverlayClick?: boolean;
  snapPoints?: number[];
  defaultSnapPoint?: number;
  showCloseButton?: boolean;
  className?: string;
}

/**
 * Mobile-first Bottom Sheet Modal
 * Slides up from bottom with drag-to-dismiss
 */
export function BottomSheet({
  isOpen,
  onClose,
  children,
  title,
  height = 'auto',
  showHandle = true,
  closeOnOverlayClick = true,
  snapPoints = [],
  defaultSnapPoint = 0,
  showCloseButton = true,
  className = ''
}: BottomSheetProps): React.JSX.Element | null {
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentHeight, setCurrentHeight] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentSnapIndex = useRef(defaultSnapPoint);

  // Calculate sheet height
  const getSheetHeight = useCallback(() => {
    if (typeof height === 'number') return height;
    if (height === 'full') return window.innerHeight * 0.95;
    if (height === 'half') return window.innerHeight * 0.5;
    
    // Auto height - measure content
    if (contentRef.current) {
      return Math.min(contentRef.current.scrollHeight + 100, window.innerHeight * 0.9);
    }
    return window.innerHeight * 0.5;
  }, [height]);

  // Handle snap points
  const snapToPoint = useCallback((index: number) => {
    if (snapPoints.length === 0) return;
    
    const point = snapPoints[index];
    const snapHeight = window.innerHeight * (point / 100);
    setCurrentHeight(snapHeight);
    currentSnapIndex.current = index;
  }, [snapPoints]);

  // Setup swipe gestures for drag to dismiss
  const { ref: dragHandleRef } = useSwipeGestures<HTMLDivElement>({
    onSwipeDown: () => {
      if (snapPoints.length > 0 && currentSnapIndex.current > 0) {
        snapToPoint(currentSnapIndex.current - 1);
      } else {
        onClose();
      }
    },
    onSwipeUp: () => {
      if (snapPoints.length > 0 && currentSnapIndex.current < snapPoints.length - 1) {
        snapToPoint(currentSnapIndex.current + 1);
      }
    }
  }, {
    threshold: 50
  });

  // Handle touch drag
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    
    const deltaY = e.touches[0].clientY - startY.current;
    setDragOffset(Math.max(0, deltaY)); // Only allow dragging down
    
    // Prevent scrolling while dragging
    e.preventDefault();
  }, [isDragging]);

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return;
    
    setIsDragging(false);
    
    // If dragged more than 100px or 30% of height, close
    const threshold = Math.min(100, currentHeight * 0.3);
    if (dragOffset > threshold) {
      onClose();
    } else {
      setDragOffset(0);
    }
  }, [isDragging, dragOffset, currentHeight, onClose]);

  // Handle opening animation
  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      setIsVisible(true);
      
      // Calculate initial height
      const initialHeight = getSheetHeight();
      setCurrentHeight(initialHeight);
      
      // If snap points are defined, snap to default
      if (snapPoints.length > 0) {
        snapToPoint(defaultSnapPoint);
      }
      
      // Focus trap
      if (sheetRef.current) {
        const focusableElements = sheetRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length > 0) {
          (focusableElements[0] as HTMLElement).focus();
        }
      }
      
      // Prevent body scroll
      document.body.style.overflow = 'hidden';
      
      setTimeout(() => setIsAnimating(false), 300);
    } else {
      setIsAnimating(true);
      setTimeout(() => {
        setIsVisible(false);
        setIsAnimating(false);
        setDragOffset(0);
      }, 300);
      
      // Restore body scroll
      document.body.style.overflow = '';
    }
  }, [isOpen, getSheetHeight, snapPoints, defaultSnapPoint, snapToPoint]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Handle overlay click
  const handleOverlayClick = useCallback(() => {
    if (closeOnOverlayClick) {
      onClose();
    }
  }, [closeOnOverlayClick, onClose]);

  if (!isVisible) return null;

  const sheetStyles = {
    // In from the iPhone Duo's status-pill column (0px elsewhere).
    left: SIDE_INSET_LEFT,
    right: SIDE_INSET_RIGHT,
    transform: `translateY(${isOpen && !isAnimating ? dragOffset : isOpen ? 0 : currentHeight}px)`,
    height: snapPoints.length > 0 ? currentHeight : height === 'auto' ? 'auto' : currentHeight,
    maxHeight: height === 'auto' ? '90vh' : undefined,
    transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
  };

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className={`absolute inset-0 bg-black transition-opacity duration-300 ${
          isOpen && !isAnimating ? 'opacity-50' : 'opacity-0'
        }`}
        onClick={handleOverlayClick}
      />

      {/* Bottom Sheet */}
      <div
        ref={sheetRef}
        className={`absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900 rounded-t-2xl shadow-2xl ${className}`}
        style={sheetStyles}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag Handle */}
        {showHandle && (
          <div 
            ref={dragHandleRef}
            className="flex justify-center py-3 cursor-grab active:cursor-grabbing"
          >
            <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
          </div>
        )}

        {/* Header */}
        {(title || showCloseButton) && (
          <div className="flex items-center justify-between px-4 pb-3 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {title}
            </h2>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                aria-label="Close"
              >
                <XIcon size={20} />
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div 
          ref={contentRef}
          className="overflow-y-auto overscroll-contain"
          style={{ maxHeight: 'calc(90vh - 100px)' }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Bottom Sheet List Item Component
 */
export function BottomSheetItem({
  icon,
  label,
  description,
  onClick,
  danger = false,
  disabled = false
}: {
  icon?: React.ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
    >
      {icon && (
        <div className={`flex-shrink-0 ${
          danger ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'
        }`}>
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className={`font-medium ${
          danger ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
        }`}>
          {label}
        </p>
        {description && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {description}
          </p>
        )}
      </div>
    </button>
  );
}

/**
 * Action Sheet - Simple bottom sheet for actions
 */
export function ActionSheet({
  isOpen,
  onClose,
  title,
  actions,
  cancelLabel = 'Cancel'
}: {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  actions: Array<{
    icon?: React.ReactNode;
    label: string;
    description?: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }>;
  cancelLabel?: string;
}) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      showCloseButton={false}
      height="auto"
    >
      <div className="py-2">
        {actions.map((action, index) => (
          <BottomSheetItem
            key={index}
            {...action}
            onClick={() => {
              action.onClick();
              onClose();
            }}
          />
        ))}
      </div>
      
      <div className="border-t border-gray-200 dark:border-gray-700 p-2">
        <button
          type="button"
          onClick={onClose}
          className="w-full justify-center py-3 font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
        >
          {cancelLabel}
        </button>
      </div>
    </BottomSheet>
  );
}
