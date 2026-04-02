import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface SelectedUser {
  userId: string;
  fullName: string;
}

interface UserContextType {
  selectedUser: SelectedUser | null;
  setSelectedUser: (user: SelectedUser) => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const [selectedUser, setSelectedUserState] = useState<SelectedUser | null>(() => {
    try {
      const saved = localStorage.getItem("selectedUser");
      return saved ? JSON.parse(saved) : { userId: "usr-001", fullName: "John Doe" };
    } catch {
      return { userId: "usr-001", fullName: "John Doe" };
    }
  });

  const setSelectedUser = (user: SelectedUser) => {
    setSelectedUserState(user);
    localStorage.setItem("selectedUser", JSON.stringify(user));
  };

  useEffect(() => {
    if (selectedUser) {
      localStorage.setItem("selectedUser", JSON.stringify(selectedUser));
    }
  }, [selectedUser]);

  return (
    <UserContext.Provider value={{ selectedUser, setSelectedUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within UserProvider");
  return ctx;
}
