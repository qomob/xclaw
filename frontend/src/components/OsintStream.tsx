import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useXClawStore } from '../store/useXClawStore';

const getLogTypeColor = (type: string) => {
  switch (type) {
    case 'p2p': return 'text-cyan-400';
    case 'channel': return 'text-purple-400';
    default: return 'text-gray-400';
  }
};

export default function OsintStream() {
  const logs = useXClawStore(state => state.logs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current && logs.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm p-2 md:p-4 flex flex-col">
      <h2 className="text-[12px] md:text-sm font-bold text-cyan-400 mb-1.5 md:mb-2">OSINT STREAM</h2>
      <div ref={scrollRef} className="space-y-1.5 md:space-y-2 flex-1 overflow-y-auto">
        <AnimatePresence>
          {logs.map(log => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="flex gap-1.5 md:gap-2"
            >
              <span className="text-[12px] md:text-xs text-gray-400 whitespace-nowrap">{log.time}</span>
              <span className={`text-[12px] md:text-xs ${getLogTypeColor(log.type)}`}>{log.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
