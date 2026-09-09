import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
    createUserWithEmailAndPassword,
    GoogleAuthProvider,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signInWithPopup,
} from "firebase/auth";
import { useState } from "react";
import {
    ActivityIndicator,
    Image,
    ImageBackground,
    Platform,
    Pressable,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { auth } from "../lib/firebase";

const friendlyFirebaseError = (err: any, isSignup = false) => {
    const message = String(err?.message || "");
    const rawCode = err?.code || message.match(/\b(auth\/[a-zA-Z-]+)\b/)?.[1] || message.match(/\((auth\/[^)]+)\)/)?.[1];

    const map: Record<string, string> = {
        'auth/invalid-credential': isSignup
            ? 'Invalid credential - please try again or reauthenticate.'
            : 'No account found with this email or invalid credentials.',
        'auth/invalid-email': 'Invalid email address.',
        'auth/user-not-found': 'No account found with this email.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/email-already-in-use': 'An account with this email already exists.',
        'auth/weak-password': 'Password is too weak (min 6 characters).',
        'auth/too-many-requests': 'Too many attempts. Try again later.',
    };

    if (rawCode && map[rawCode]) return map[rawCode];

    const lower = message.toLowerCase();
    if (lower.includes('user-not-found') || lower.includes('no user record') || lower.includes('no user')) return 'No account found with this email.';
    if (lower.includes('wrong-password') || lower.includes('invalid password')) return 'Incorrect password.';
    if (lower.includes('invalid-credential')) return isSignup ? 'Invalid credential - please try again or reauthenticate.' : 'No account found with this email or invalid credentials.';
    if (lower.includes('email already in use') || lower.includes('email-already-in-use')) return 'An account with this email already exists.';
    if (lower.includes('weak-password')) return 'Password is too weak (min 6 characters).';

    if (rawCode) {
        return rawCode
            .replace(/^auth\//, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (c: string) => c.toUpperCase());
    }

    return message || 'Authentication failed.';
};

export default function AuthScreen() {
    const router = useRouter();

    const [isSignup, setIsSignup] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);

    const handleAuth = async () => {
        setError(null);

        if (!email.trim() || !password) {
            setError("Please enter both email and password.");
            return;
        }

        if (isSignup && password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }

        setError(null);
        setInfoMessage(null);
        setLoading(true);
        try {
            if (isSignup) {
                await createUserWithEmailAndPassword(auth, email.trim(), password);
            } else {
                await signInWithEmailAndPassword(auth, email.trim(), password);
            }

            router.replace("/dashboard");
        } catch (err: any) {
            setError(friendlyFirebaseError(err, isSignup));
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordReset = async () => {
        setError(null);
        setInfoMessage(null);

        if (!email.trim()) {
            setError("Enter your email to reset your password.");
            return;
        }

        setLoading(true);
        try {
            await sendPasswordResetEmail(auth, email.trim());
            setInfoMessage("Password reset email sent. Check your inbox.");
        } catch (err: any) {
            setError(friendlyFirebaseError(err));
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleSignIn = async () => {
        setError(null);
        setInfoMessage(null);

        if (Platform.OS !== "web") {
            setError("Google sign-in is currently supported on web only.");
            return;
        }

        setLoading(true);
        try {
            const provider = new GoogleAuthProvider();
            await signInWithPopup(auth, provider);
            router.replace("/dashboard");
        } catch (err: any) {
            setError(friendlyFirebaseError(err));
        } finally {
            setLoading(false);
        }
    };

    // Use a local asset for the background so you can place your provided image in src/assets/login-bg.png
    const bgImage = require('../assets/login-bg.png');
    // Add a local google logo at src/assets/google-logo.png (recommended for native builds)
    const googleLogo = require('../assets/google-logo.png');

    return (
       <ImageBackground
    source={bgImage}
    style={styles.background}
    resizeMode="cover"
>
    <View style={styles.overlay} />

    <SafeAreaView style={styles.container}>
                <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.40)' }} />

                <View style={styles.header}>
                    <View style={styles.logoWrap}>
                        <Image
                            source={{ uri: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png" }}
                            style={styles.logo}
                        />
                    </View>

                    <Text style={styles.title}>
                        <Text style={styles.titleMain}>Estate</Text>
                        <Text style={styles.titleAccent}>Flow</Text>
                    </Text>
                    <Text style={styles.tagline}>Modern Property Management</Text>

                    <Text style={styles.heroText}>Everything you need to manage{"\n"}your real estate portfolio.</Text>
                </View>

                <View style={styles.card}>
                    <View style={styles.inputContainer}>
                        <Feather name="mail" size={18} color="#60A5FA" style={styles.inputIcon} />
                        <TextInput
                            placeholder="Email"
                            placeholderTextColor="#9CA3AF"
                            style={styles.input}
                            keyboardType="email-address"
                            autoCapitalize="none"
                            value={email}
                            onChangeText={setEmail}
                        />
                    </View>

                    <View style={styles.inputContainer}>
                        <Feather name="lock" size={18} color="#60A5FA" style={styles.inputIcon} />
                        <TextInput
                            placeholder="Password"
                            placeholderTextColor="#9CA3AF"
                            secureTextEntry={!showPassword}
                            style={styles.input}
                            value={password}
                            onChangeText={setPassword}
                        />
                        <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                            <Feather name={showPassword ? "eye-off" : "eye"} size={18} color="#60A5FA" />
                        </Pressable>
                    </View>

                    {isSignup && (
                        <View style={styles.inputContainer}>
                            <Feather name="lock" size={18} color="#60A5FA" style={styles.inputIcon} />
                            <TextInput
                                placeholder="Confirm Password"
                                placeholderTextColor="#9CA3AF"
                                secureTextEntry={!showConfirmPassword}
                                style={styles.input}
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                            />
                            <Pressable onPress={() => setShowConfirmPassword(!showConfirmPassword)} style={styles.eyeButton}>
                                <Feather name={showConfirmPassword ? "eye-off" : "eye"} size={18} color="#60A5FA" />
                            </Pressable>
                        </View>
                    )}

                    {!isSignup && (
                        <Pressable onPress={handlePasswordReset} style={styles.forgotButton}>
                            <Text style={styles.forgotText}>Forgot password?</Text>
                        </Pressable>
                    )}

                    {error ? (
                        <Text style={styles.errorText}>{error}</Text>
                    ) : null}
                    {infoMessage ? (
                        <Text style={styles.infoText}>{infoMessage}</Text>
                    ) : null}

                    <Pressable
                        style={[styles.button, loading && { opacity: 0.9 }]}
                        onPress={handleAuth}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.buttonText}>{isSignup ? "Create Account" : "Sign In"}</Text>
                        )}
                    </Pressable>

                    <View style={styles.orRow}>
                        <View style={styles.orLine} />
                        <Text style={styles.orText}>OR</Text>
                        <View style={styles.orLine} />
                    </View>

                    <Pressable
                        style={styles.googleButton}
                        onPress={handleGoogleSignIn}
                        disabled={loading}
                    >
                        <Image source={googleLogo} style={styles.googleLogo} resizeMode="contain" />
                        <Text style={styles.googleButtonText}>Continue with Google</Text>
                    </Pressable>

                    <View style={styles.bottomSection}>
                        {isSignup ? (
                            <>
                                <Text style={styles.bottomText}>
                                    Already have an account?
                                </Text>

                                <Pressable onPress={() => setIsSignup(false)}>
                                    <Text style={styles.bottomLink}>
                                        Sign In
                                    </Text>
                                </Pressable>
                            </>
                        ) : (
                            <>
                                <Text style={styles.bottomText}>
                                    Don't have an account?
                                </Text>

                                <Pressable onPress={() => setIsSignup(true)}>
                                    <Text style={styles.bottomLink}>
                                        Create one
                                    </Text>
                                </Pressable>
                            </>
                        )}
                    </View>
                </View>

            </SafeAreaView>
        </ImageBackground>
    );
}

const styles = StyleSheet.create({
    background: {
        flex: 1,
        backgroundColor: "#0B1120",
        width: '100%',
        height: '100%'
    },
    backgroundImage: {
        opacity: 0.95,
        width: '100%',
        height: '100%'
    },
    overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.42)",
},
    container: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 24,
    },
    header: {
        alignItems: "center",
        marginTop: 0,
        marginBottom: 12,
    },
   logoWrap: {
    width: 92,
    height: 92,
    borderRadius: 24,
    backgroundColor: "#1D4ED8",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 22,

    shadowColor: "#2563EB",
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 12,
},
    logo: {
        width: 72,
        height: 72,
        tintColor: '#2B6CE4'
    },
    title: {
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: -1,
},
    titleMain: { color: '#FFFFFF' },
    titleAccent: { color: '#3B82F6' },
    tagline: {
        color: "#94A3B8",
        fontSize: 14,
        marginBottom: 12,
    },
    heroText:{
    width:"82%",
    textAlign:"center",
    color:"#C8D2E2",
    fontSize:17,
    lineHeight:28,
    marginTop:18,
    marginBottom:34,
},
   card:{
    width:"92%",
    maxWidth:480,

    borderRadius:34,

    paddingHorizontal:26,
    paddingVertical:28,

    backgroundColor:"rgba(10,18,35,.93)",

    borderWidth:1.4,
    borderColor:"rgba(59,130,246,.35)",

    shadowColor:"#2563EB",
    shadowOpacity:.25,
    shadowRadius:30,
},
    button: {
        backgroundColor: "#2563EB",
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: "center",
        marginTop: 8,
        // make button pop
        shadowColor: '#153bfc',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.35,
        shadowRadius: 18,
    },
    buttonText: {
        color: "#FFFFFF",
        fontWeight: "700",
        fontSize: 18,
    },
    googleButton: {
        backgroundColor: "#070D18",
        height:55,
        paddingVertical: 12,
        borderRadius: 18,
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "center",
        marginTop: 12,
        borderWidth: 1.2,
        borderColor: "#334155",
    },
    googleLogo: {
        width: 28,
        height: 28,
        marginRight: 12,
    },
    googleButtonText: {
        color: "#FFFFFF",
        fontWeight: "700",
        fontSize: 16,
    },
    inputContainer: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "rgba(255,255,255,0.01)",
        borderColor: "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        marginBottom: 12,
        height: 56,
    },
    inputIcon: { marginRight: 12 },
    input: {
        flex: 1,
        color: "#FFFFFF",
        fontSize: 16,

        paddingVertical: 12,
    },
    eyeButton: { padding: 8 },
    forgotButton: { alignSelf: "flex-end", marginBottom: 8 },
    forgotText: { color: "#60A5FA", fontSize: 14 },
    errorText: { color: "#F87171", marginBottom: 8 },
    infoText: { color: "#A5F3FC", marginBottom: 8 },
    link: { color: "#60A5FA", textAlign: "center", marginTop: 12, fontSize: 15 },
    orRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
    orLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.03)' },
    orText: { color: '#9CA3AF', marginHorizontal: 10 },
    bottomSection: {
        alignItems: "center",
        marginTop: 36,
    },

    bottomText: {
        color: "#B6C2D2",
        fontSize: 17,
    },

    bottomLink: {
        marginTop: 12,
        fontSize: 16,
        fontWeight: "700",
        color: "#3B82F6",
    },
});
